/**
 * FLAC (Free Lossless Audio Codec) encoder. Pure TypeScript, no DOM; runs in Node, a Worker or the main thread.
 *
 * What it writes (RFC 9639): a STREAMINFO block (with the MD5 of the audio), then frames of 4096 samples.
 * Each frame picks, per channel, the smallest of CONSTANT, VERBATIM, FIXED (orders 0–4) and LPC
 * (Levinson–Durbin on a Tukey-windowed block, order chosen from the prediction error, quantized
 * coefficients), with partitioned Rice-coded residuals (`flac-subframes.ts`, `flac-rice.ts`); stereo frames
 * also try left/side, right/side and mid/side. Correctness first: every frame decodes bit-exactly to the
 * quantized input (the browser test checks it against Chrome's own decoder).
 */
import { BitWriter } from './flac-bits';
import {
  BLOCK_SIZE_CODE_16_BIT,
  BLOCK_SIZE_CODE_4096,
  BLOCK_SIZE_CODE_8_BIT,
  BLOCK_TYPE_STREAMINFO,
  CHANNELS_INDEPENDENT_STEREO,
  CHANNELS_LEFT_SIDE,
  CHANNELS_MID_SIDE,
  CHANNELS_SIDE_RIGHT,
  FLAC_STREAM_MARKER,
  FRAME_SYNC_CODE,
  SAMPLE_RATE_CODES,
  SAMPLE_SIZE_CODE_16_BIT,
  SAMPLE_SIZE_CODE_24_BIT,
  STREAMINFO_BODY_BYTES,
  STREAMINFO_MD5_OFFSET,
  STREAM_HEADER_BYTES,
  crc16,
  crc8,
  interleavedBytes,
} from './flac-format';
import { Workspace, planFixed, refineLpc, type SubframePlan } from './flac-subframes';
import { Md5 } from './md5';
import { PcmQuantizer, quantizePcm } from './wav';

/** The bit depths FLAC export offers. */
export type FlacBitDepth = 16 | 24;

export interface EncodeFlacOptions {
  bitDepth: FlacBitDepth;
  /** TPDF dither before quantizing (16-bit only), the same noise as the WAV encoder. */
  dither?: boolean;
  seed?: number;
  /** Samples per frame (16–65535, default 4096). */
  blockSize?: number;
  /** Highest LPC order tried (0 = fixed predictors only; default 8, at most 32). */
  maxLpcOrder?: number;
}

const DEFAULT_BLOCK_SIZE = 4096;
/** The smallest block size libFLAC accepts, and the largest the 16-bit STREAMINFO fields can hold. */
const MIN_BLOCK_SIZE = 16;
const MAX_BLOCK_SIZE = 65535;
const DEFAULT_MAX_LPC_ORDER = 8;
/** FLAC's own limit on the LPC order. */
const MAX_LPC_ORDER = 32;
const MAX_CHANNELS = 8;
/** The highest sample rate a frame header can state (65535 units of 10 Hz). */
const MAX_SAMPLE_RATE_HZ = 655350;
/** Blocks of this many samples or fewer use the 8-bit block size field in the frame header. */
const SHORT_BLOCK_MAX_SAMPLES = 256;

/** Encodes float audio (quantized exactly like encodeWav at the same depth, dither and seed). */
export function encodeFlac(channels: Float32Array[], sampleRate: number, opts: EncodeFlacOptions): Uint8Array {
  const pcm = quantizePcm(channels, opts.bitDepth, { dither: !!opts.dither, seed: opts.seed });
  return encodeFlacPcm(pcm, sampleRate, opts);
}

/** Encodes integer samples (one Int32Array per channel, within the bit depth's range). */
export function encodeFlacPcm(
  samples: readonly Int32Array[],
  sampleRate: number,
  opts: Pick<EncodeFlacOptions, 'bitDepth' | 'blockSize' | 'maxLpcOrder'>,
): Uint8Array {
  const total = samples[0]?.length ?? 0;
  if (samples.some((c) => c.length !== total)) {
    throw new RangeError('encodeFlac: all channels must have the same length.');
  }
  const encoder = new FlacStreamEncoder(samples.length, sampleRate, opts);
  const parts = [encoder.header(), encoder.pushPcm(samples), encoder.finish()];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  // The first header was written before the length, frame sizes and MD5 were known: replace it.
  out.set(encoder.header(), 0);
  return out;
}

/**
 * FLAC written a piece at a time (long exports): `header()` first (STREAMINFO without the length,
 * frame sizes and MD5 yet), then the frames as audio is pushed (whole blocks; the rest waits for the
 * next push), `finish()` for the last block, and `header()` again, now complete, to write over the
 * first one (it has the same size). The bytes are encodeFlac's, however the audio is split.
 */
export class FlacStreamEncoder {
  private readonly blockSize: number;
  private readonly maxLpcOrder: number;
  private readonly bitsPerSample: FlacBitDepth;
  private readonly quantizer: PcmQuantizer;
  private readonly work: Workspace;
  private readonly md5 = new Md5();
  /** Samples waiting for a whole block. */
  private readonly pending: Int32Array[];
  private pendingLength = 0;
  private frameNumber = 0;
  private totalSamples = 0;
  private minFrameBytes = Infinity;
  private maxFrameBytes = 0;
  private finished = false;
  /** The MD5 of the audio, known once `finish` has run. */
  private digest: Uint8Array | null = null;

  constructor(
    readonly numChannels: number,
    readonly sampleRate: number,
    opts: Pick<EncodeFlacOptions, 'bitDepth' | 'blockSize' | 'maxLpcOrder' | 'dither' | 'seed'>,
  ) {
    if (numChannels < 1 || numChannels > MAX_CHANNELS) {
      throw new RangeError(`encodeFlac: FLAC holds 1 to ${MAX_CHANNELS} channels.`);
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > MAX_SAMPLE_RATE_HZ) {
      throw new RangeError(`encodeFlac: invalid sample rate ${sampleRate}.`);
    }
    this.bitsPerSample = opts.bitDepth;
    if (this.bitsPerSample !== 16 && this.bitsPerSample !== 24) throw new RangeError('encodeFlac: 16 or 24 bits.');
    this.blockSize = Math.max(
      MIN_BLOCK_SIZE,
      Math.min(MAX_BLOCK_SIZE, Math.round(opts.blockSize ?? DEFAULT_BLOCK_SIZE)),
    );
    this.maxLpcOrder = Math.max(0, Math.min(MAX_LPC_ORDER, Math.round(opts.maxLpcOrder ?? DEFAULT_MAX_LPC_ORDER)));
    this.quantizer = new PcmQuantizer(this.bitsPerSample, { dither: !!opts.dither, seed: opts.seed });
    this.work = new Workspace(this.blockSize);
    this.pending = Array.from({ length: numChannels }, () => new Int32Array(this.blockSize));
  }

  /** "fLaC" and STREAMINFO (42 bytes in all): complete once `finish` has run. */
  header(): Uint8Array {
    const writer = new BitWriter(STREAM_HEADER_BYTES);
    writer.write(FLAC_STREAM_MARKER, 32);
    // Metadata block header (RFC 9639 §8.1): last-block flag, block type, body length in bytes.
    writer.write(1, 1);
    writer.write(BLOCK_TYPE_STREAMINFO, 7);
    writer.write(STREAMINFO_BODY_BYTES, 24);
    // STREAMINFO body (§8.2), in order.
    const total = this.totalSamples;
    writer.write(this.blockSize, 16); // minimum block size
    writer.write(this.blockSize, 16); // maximum block size
    writer.write(total > 0 && Number.isFinite(this.minFrameBytes) ? this.minFrameBytes : 0, 24);
    writer.write(this.maxFrameBytes, 24);
    writer.write(this.sampleRate, 20);
    writer.write(this.numChannels - 1, 3);
    writer.write(this.bitsPerSample - 1, 5);
    writer.write(Math.floor(total / 2 ** 32), 4); // total samples, high 4 of 36 bits
    writer.write(total >>> 0, 32); // total samples, low 32 bits
    // The MD5 signature (128 bits) is not bit-written: it is copied in once it is known.
    const written = writer.finish();
    const header = new Uint8Array(STREAM_HEADER_BYTES);
    header.set(written, 0);
    if (this.digest) header.set(this.digest, STREAMINFO_MD5_OFFSET);
    return header;
  }

  /** Float audio: quantized (with the dither carried on), then encoded. */
  push(channels: readonly Float32Array[]): Uint8Array {
    return this.pushPcm(this.quantizer.quantize(channels));
  }

  /** Integer samples: the frames of every whole block they complete. */
  pushPcm(samples: readonly Int32Array[]): Uint8Array {
    if (this.finished) throw new Error('encodeFlac: already finished.');
    if (samples.length !== this.numChannels) throw new RangeError('encodeFlac: wrong number of channels.');
    const sampleCount = samples[0]?.length ?? 0;
    // A first guess of half the raw size (lossless audio rarely compresses worse); the writer grows if wrong.
    const rawBytes = (sampleCount * this.numChannels * this.bitsPerSample) / 8;
    const writer = new BitWriter(Math.max(1024, Math.ceil(rawBytes / 2) + 1024));
    let offset = 0;
    while (offset < sampleCount) {
      const take = Math.min(this.blockSize - this.pendingLength, sampleCount - offset);
      if (this.pendingLength === 0 && take === this.blockSize) {
        // A whole block straight from the input.
        this.encodeBlock(
          writer,
          samples.map((c) => c.subarray(offset, offset + take)),
          take,
        );
      } else {
        samples.forEach((c, ch) =>
          (this.pending[ch] as Int32Array).set(c.subarray(offset, offset + take), this.pendingLength),
        );
        this.pendingLength += take;
        if (this.pendingLength === this.blockSize) {
          this.encodeBlock(writer, this.pending, this.blockSize);
          this.pendingLength = 0;
        }
      }
      offset += take;
    }
    return writer.finish();
  }

  /** The last (partial) block. Write `header()` over the first 42 bytes afterwards. */
  finish(): Uint8Array {
    const rawBytes = Math.ceil((this.pendingLength * this.numChannels * this.bitsPerSample) / 8);
    const writer = new BitWriter(Math.max(1024, rawBytes * 2 + 1024));
    if (this.pendingLength > 0) {
      const lastBlock = this.pending.map((c) => c.subarray(0, this.pendingLength));
      this.encodeBlock(writer, lastBlock, this.pendingLength);
      this.pendingLength = 0;
    }
    this.finished = true;
    this.digest = this.md5.digest();
    return writer.finish();
  }

  private encodeBlock(writer: BitWriter, channels: Int32Array[], blockLength: number): void {
    this.md5.update(interleavedBytes(channels, blockLength, this.bitsPerSample / 8));
    const frameStart = writer.bytePos;
    writeFrame(writer, channels, blockLength, this.frameSettings());
    const frameBytes = writer.bytePos - frameStart;
    this.minFrameBytes = Math.min(this.minFrameBytes, frameBytes);
    this.maxFrameBytes = Math.max(this.maxFrameBytes, frameBytes);
    this.frameNumber++;
    this.totalSamples += blockLength;
  }

  private frameSettings(): FrameSettings {
    return {
      bitsPerSample: this.bitsPerSample,
      sampleRate: this.sampleRate,
      frameNumber: this.frameNumber,
      blockSize: this.blockSize,
      maxLpcOrder: this.maxLpcOrder,
      work: this.work,
    };
  }
}

/** What `writeFrame` needs to know about the stream and the frame's place in it. */
interface FrameSettings {
  bitsPerSample: number;
  sampleRate: number;
  /** The frame's index in the stream (it is written in the frame header). */
  frameNumber: number;
  /** The stream's nominal block size (only the last block is shorter). */
  blockSize: number;
  maxLpcOrder: number;
  work: Workspace;
}

/** The coding chosen for every channel of a frame, and the channel assignment code that says so. */
interface ChannelPlans {
  plans: SubframePlan[];
  /** The frame header's "channel assignment" (RFC 9639 §9.1.3). */
  channelAssignment: number;
}

function writeFrame(writer: BitWriter, channels: Int32Array[], blockLength: number, settings: FrameSettings): void {
  const { plans, channelAssignment } = chooseChannelPlans(channels, blockLength, settings);
  const frameStart = writer.bytePos;
  writeFrameHeader(writer, blockLength, channelAssignment, settings);
  for (const plan of plans) plan.write(writer, settings.work);
  writer.align();
  writer.write(crc16(writer.bytes, frameStart, writer.bytePos), 16);
}

/** Channel decorrelation: tries every stereo mode and keeps the smallest. Other layouts code each channel alone. */
function chooseChannelPlans(channels: Int32Array[], blockLength: number, settings: FrameSettings): ChannelPlans {
  const { bitsPerSample, maxLpcOrder, work } = settings;
  if (channels.length !== 2) {
    return {
      plans: channels.map((c) => refineLpc(planFixed(c, bitsPerSample, work), maxLpcOrder, work)),
      channelAssignment: channels.length - 1,
    };
  }
  const left = channels[0] as Int32Array;
  const right = channels[1] as Int32Array;
  const mid = work.mid.subarray(0, blockLength);
  const side = work.side.subarray(0, blockLength);
  for (let i = 0; i < blockLength; i++) {
    const l = left[i] as number;
    const r = right[i] as number;
    mid[i] = (l + r) >> 1;
    side[i] = l - r;
  }
  // The stereo mode is chosen on the fixed predictors (cheap); LPC then refines the two it keeps.
  const leftPlan = planFixed(left, bitsPerSample, work);
  const rightPlan = planFixed(right, bitsPerSample, work);
  const midPlan = planFixed(mid, bitsPerSample, work);
  const sidePlan = planFixed(side, bitsPerSample + 1, work); // the side channel needs one more bit
  const options: [number, SubframePlan, SubframePlan][] = [
    [CHANNELS_INDEPENDENT_STEREO, leftPlan, rightPlan],
    [CHANNELS_LEFT_SIDE, leftPlan, sidePlan],
    [CHANNELS_SIDE_RIGHT, sidePlan, rightPlan],
    [CHANNELS_MID_SIDE, midPlan, sidePlan],
  ];
  let best = options[0]!;
  for (const option of options) {
    if (option[1].bits + option[2].bits < best[1].bits + best[2].bits) best = option;
  }
  return {
    plans: [refineLpc(best[1], maxLpcOrder, work), refineLpc(best[2], maxLpcOrder, work)],
    channelAssignment: best[0],
  };
}

/** The frame header (RFC 9639 §9.1) up to and including its CRC-8. */
function writeFrameHeader(
  writer: BitWriter,
  blockLength: number,
  channelAssignment: number,
  settings: FrameSettings,
): void {
  const { bitsPerSample, sampleRate, frameNumber, blockSize } = settings;
  const frameStart = writer.bytePos;
  writer.write(FRAME_SYNC_CODE, 14);
  writer.write(0, 1); // reserved
  writer.write(0, 1); // blocking strategy: fixed block size
  const blockSizeCode = blockSizeCodeFor(blockLength, blockSize);
  writer.write(blockSizeCode, 4);
  writer.write(SAMPLE_RATE_CODES[sampleRate] ?? 0, 4); // 0 = "get it from STREAMINFO"
  writer.write(channelAssignment, 4);
  writer.write(bitsPerSample === 16 ? SAMPLE_SIZE_CODE_16_BIT : SAMPLE_SIZE_CODE_24_BIT, 3);
  writer.write(0, 1); // reserved
  writeUtf8Number(writer, frameNumber);
  if (blockSizeCode === BLOCK_SIZE_CODE_8_BIT) writer.write(blockLength - 1, 8);
  else if (blockSizeCode === BLOCK_SIZE_CODE_16_BIT) writer.write(blockLength - 1, 16);
  writer.write(crc8(writer.bytes, frameStart, writer.bytePos), 8);
}

/** The header's block size code: the common 4096 has its own, anything else spells the size out. */
function blockSizeCodeFor(blockLength: number, nominalBlockSize: number): number {
  if (blockLength === nominalBlockSize && nominalBlockSize === DEFAULT_BLOCK_SIZE) return BLOCK_SIZE_CODE_4096;
  return blockLength <= SHORT_BLOCK_MAX_SAMPLES ? BLOCK_SIZE_CODE_8_BIT : BLOCK_SIZE_CODE_16_BIT;
}

/** The frame number in the header's UTF-8-style coding (RFC 9639 §9.1.5): up to 6 bytes for 31 bits. */
function writeUtf8Number(writer: BitWriter, value: number): void {
  if (value < 0x80) {
    writer.write(value, 8);
    return;
  }
  let byteCount = 2;
  while (byteCount < 6 && value >= 2 ** (5 * byteCount + 1)) byteCount++;
  const leadByte = (0xff00 >> byteCount) & 0xff;
  writer.write(leadByte | Math.floor(value / 2 ** (6 * (byteCount - 1))), 8);
  for (let i = byteCount - 2; i >= 0; i--) writer.write(0x80 | (Math.floor(value / 2 ** (6 * i)) & 0x3f), 8);
}
