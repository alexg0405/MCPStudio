/**
 * WAV export encoding (`encodeWav`, `WavStreamEncoder`) and the quantizer FLAC shares. Reading WAV and AIFF is
 * `wav-decode.ts`; its `decodePcm` is re-exported here. Pure TypeScript, no DOM; runs in Node, the main thread or a Worker.
 */
import { WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_PCM } from './wav-format';

export { decodePcm } from './wav-decode';
export type { DecodedPcm } from './wav-format';

/** The bit depths the WAV encoder can write: 16 or 24 (whole-number samples) or 32 (floating point). */
export type WavBitDepth = 16 | 24 | 32;

/** How to write a WAV file: the bit depth, and whether and how to dither 16-bit output. */
export interface EncodeWavOptions {
  /** 16/24 = integer PCM, 32 = IEEE float. */
  bitDepth: WavBitDepth;
  /** TPDF dither before quantizing (16-bit only; 24-bit and float are written undithered). */
  dither?: boolean;
  /** Seed for the dither noise. The same input and seed always produce the same bytes. */
  seed?: number;
}

const DEFAULT_DITHER_SEED = 0x2545f491;
/** RIFF sizes are 32-bit, so a WAV file holds at most 4 GiB. */
const MAX_RIFF_SIZE = 0xffffffff;
const MAX_CHANNELS = 0xffff;
const MAX_SAMPLE_RATE = 0xffffffff;

// Header layout written below: "RIFF" + size + "WAVE" (12 bytes), the "fmt " chunk (8-byte chunk header and a
// 16-byte PCM or 18-byte WAVEFORMATEX body), for float a "fact" chunk (8 + 4 bytes), then the "data" chunk
// header (8 bytes), after which the audio starts.
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const FMT_BODY_BYTES_PCM = 16;
const FMT_BODY_BYTES_FLOAT = 18;
const FACT_CHUNK_BYTES = 12;

// ---------------------------------------------------------------------------------------------
// Encoding

/**
 * Encodes interleaved RIFF/WAVE: PCM integers for 16/24-bit, IEEE float (with a `fact` chunk) for
 * 32-bit. Samples are clipped to [-1, 1] and NaN becomes 0. Integers use a 2^(bits-1) scale with
 * rounding, so decoding by the same scale is accurate to half a step (one step at +1.0).
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, opts: EncodeWavOptions): Uint8Array {
  const frames = (channels[0] as Float32Array | undefined)?.length ?? 0;
  if (channels.some((c) => c.length !== frames))
    throw new RangeError('encodeWav: all channels must have the same length.');
  const enc = new WavStreamEncoder(channels.length, sampleRate, opts);
  const header = enc.header(frames);
  const data = enc.push(channels);
  const tail = enc.trailer();
  const out = new Uint8Array(header.length + data.length + tail.length);
  out.set(header, 0);
  out.set(data, header.length);
  out.set(tail, header.length + data.length);
  return out;
}

/**
 * WAV written a piece at a time (long exports): the header (written first with a guess, then again
 * with the real length at the start of the file once it is known), the audio as it comes, and a pad
 * byte. The bytes are the same as encodeWav's for the same audio, however it is split.
 */
export class WavStreamEncoder {
  private readonly quantizer: PcmQuantizer | null;
  private frames = 0;
  readonly headerSize: number;

  constructor(
    readonly numChannels: number,
    readonly sampleRate: number,
    readonly opts: EncodeWavOptions,
  ) {
    if (numChannels < 1 || numChannels > MAX_CHANNELS)
      throw new RangeError('encodeWav needs between 1 and 65535 channels.');
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > MAX_SAMPLE_RATE) {
      throw new RangeError(`encodeWav: invalid sample rate ${sampleRate}.`);
    }
    const { bitDepth } = opts;
    if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32)
      throw new RangeError(`encodeWav: unsupported bit depth.`);
    this.quantizer =
      bitDepth === 32
        ? null
        : new PcmQuantizer(bitDepth, { dither: !!opts.dither && bitDepth === 16, seed: opts.seed });
    const isFloat = bitDepth === 32;
    const fmtBodyBytes = isFloat ? FMT_BODY_BYTES_FLOAT : FMT_BODY_BYTES_PCM;
    this.headerSize =
      RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES + fmtBodyBytes + (isFloat ? FACT_CHUNK_BYTES : 0) + CHUNK_HEADER_BYTES;
  }

  /** Frames pushed so far. */
  get framesWritten(): number {
    return this.frames;
  }

  /** The header for a file of `frames` frames (the bytes before the audio). */
  header(frames = this.frames): Uint8Array {
    const { bitDepth } = this.opts;
    const numChannels = this.numChannels;
    const isFloat = bitDepth === 32;
    const blockAlign = numChannels * (bitDepth / 8);
    const dataSize = frames * blockAlign;
    const fmtSize = isFloat ? FMT_BODY_BYTES_FLOAT : FMT_BODY_BYTES_PCM; // WAVEFORMATEX with cbSize = 0 for non-PCM formats
    const total = this.headerSize + dataSize + (dataSize & 1);
    if (total - 8 > MAX_RIFF_SIZE) throw new RangeError('encodeWav: the audio is too long for a WAV file (4 GiB).');
    const out = new Uint8Array(this.headerSize);
    const view = new DataView(out.buffer);
    writeTag(out, 0, 'RIFF');
    view.setUint32(4, total - 8, true);
    writeTag(out, 8, 'WAVE');
    writeTag(out, 12, 'fmt ');
    view.setUint32(16, fmtSize, true);
    view.setUint16(20, isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, (this.sampleRate * blockAlign) % 0x100000000, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    let o = RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES + FMT_BODY_BYTES_PCM; // after the 16 bytes both formats share
    if (isFloat) {
      view.setUint16(o, 0, true); // cbSize
      o += 2;
      writeTag(out, o, 'fact');
      view.setUint32(o + 4, 4, true);
      view.setUint32(o + 8, frames, true);
      o += 12;
    }
    writeTag(out, o, 'data');
    view.setUint32(o + 4, dataSize, true);
    return out;
  }

  /** The audio bytes of the next frames. */
  push(channels: readonly Float32Array[]): Uint8Array {
    const numChannels = this.numChannels;
    if (channels.length !== numChannels) throw new RangeError('encodeWav: wrong number of channels.');
    const frames = channels[0]?.length ?? 0;
    if (channels.some((c) => c.length !== frames))
      throw new RangeError('encodeWav: all channels must have the same length.');
    const { bitDepth } = this.opts;
    const out = new Uint8Array(frames * numChannels * (bitDepth / 8));
    const view = new DataView(out.buffer);
    let o = 0;
    if (this.quantizer) {
      const pcm = this.quantizer.quantize(channels);
      if (bitDepth === 16) {
        for (let i = 0; i < frames; i++)
          for (let c = 0; c < numChannels; c++) {
            view.setInt16(o, (pcm[c] as Int32Array)[i] as number, true);
            o += 2;
          }
      } else {
        for (let i = 0; i < frames; i++)
          for (let c = 0; c < numChannels; c++) {
            const v = (pcm[c] as Int32Array)[i] as number;
            out[o] = v & 0xff;
            out[o + 1] = (v >> 8) & 0xff;
            out[o + 2] = (v >> 16) & 0xff;
            o += 3;
          }
      }
    } else {
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < numChannels; c++) {
          view.setFloat32(o, clip((channels[c] as Float32Array)[i] as number), true);
          o += 4;
        }
    }
    this.frames += frames;
    return out;
  }

  /** What follows the audio: a pad byte when its size is odd. */
  trailer(): Uint8Array {
    return new Uint8Array(((this.frames * this.numChannels * this.opts.bitDepth) / 8) & 1);
  }
}

/**
 * The integers encodeWav writes at 16 or 24 bits (the same clipping, rounding and, for the same
 * seed, the same TPDF dither noise), one Int32Array per channel. The FLAC encoder writes these, so
 * a FLAC and a WAV export of one render decode to the same samples.
 */
export function quantizePcm(
  channels: Float32Array[],
  bitDepth: 16 | 24,
  opts: { dither?: boolean; seed?: number | undefined } = {},
): Int32Array[] {
  const frames = channels[0]?.length ?? 0;
  if (channels.some((c) => c.length !== frames))
    throw new RangeError('quantizePcm: all channels must have the same length.');
  return new PcmQuantizer(bitDepth, opts).quantize(channels);
}

/** quantizePcm a piece at a time: the dither noise continues across pieces, so the result is the same. */
export class PcmQuantizer {
  private readonly rand: (() => number) | null;

  constructor(
    readonly bitDepth: 16 | 24,
    opts: { dither?: boolean; seed?: number | undefined } = {},
  ) {
    this.rand = bitDepth === 16 && opts.dither ? mulberry32(opts.seed ?? DEFAULT_DITHER_SEED) : null;
  }

  quantize(channels: readonly Float32Array[]): Int32Array[] {
    const frames = channels[0]?.length ?? 0;
    const out = channels.map(() => new Int32Array(frames));
    const n = channels.length;
    if (this.bitDepth === 16) {
      const rand = this.rand;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < n; c++) {
          let s = clip((channels[c] as Float32Array)[i] as number) * 32768;
          if (rand) s += rand() - rand(); // TPDF: triangular noise in (-1, 1) LSB
          s = Math.round(s);
          (out[c] as Int32Array)[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
        }
      }
    } else {
      for (let c = 0; c < n; c++) {
        const src = channels[c] as Float32Array;
        const dst = out[c] as Int32Array;
        for (let i = 0; i < frames; i++) {
          const v = Math.round(clip(src[i] as number) * 8388608);
          dst[i] = v > 8388607 ? 8388607 : v;
        }
      }
    }
    return out;
  }
}

function clip(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x === x ? x : 0;
}

/** Seeded uniform [0, 1) generator (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeTag(bytes: Uint8Array, o: number, tag: string): void {
  for (let i = 0; i < 4; i++) bytes[o + i] = tag.charCodeAt(i);
}
