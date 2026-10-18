/**
 * FLAC decoder (RFC 9639): every frame and subframe type, fixed or variable block size, CRCs checked, and
 * the MD5 of the decoded audio compared with the one STREAMINFO declares. Used to read FLAC samples and to
 * verify the encoder. Pure TypeScript, no DOM.
 */
import { BitReader } from './flac-bits';
import {
  BLOCK_SIZE_CODE_16_BIT,
  BLOCK_SIZE_CODE_8_BIT,
  BLOCK_TYPE_STREAMINFO,
  CHANNELS_LEFT_SIDE,
  CHANNELS_MID_SIDE,
  CHANNELS_SIDE_RIGHT,
  FLAC_STREAM_MARKER,
  FRAME_SYNC_CODE,
  FlacError,
  MD5_BYTES,
  SUBFRAME_TYPE_CONSTANT,
  SUBFRAME_TYPE_FIXED_BASE,
  SUBFRAME_TYPE_LPC_BASE,
  SUBFRAME_TYPE_VERBATIM,
  crc16,
  crc8,
  interleavedBytes,
} from './flac-format';
import { Md5 } from './md5';

/** A decoded FLAC file. */
export interface DecodedFlac {
  sampleRate: number;
  bitDepth: number;
  /** Integer samples per channel. */
  channels: Int32Array[];
  /** The MD5 STREAMINFO declares (hex), and whether the decoded audio matches it. */
  md5: string;
  md5Ok: boolean;
}

/** What STREAMINFO says about the stream (RFC 9639 §8.2). */
interface StreamInfo {
  sampleRate: number;
  bitsPerSample: number;
  channelCount: number;
  totalSamples: number;
  md5Hex: string;
}

/** The fields of a frame header (§9.1) that decoding needs. */
interface FrameHeader {
  blockSize: number;
  channelAssignment: number;
  /** Bits per sample of the frame (STREAMINFO's when the header says so). */
  bitsPerSample: number;
}

/** Block size header code 1 means 192 samples (codes 2–5 are 576 << (code − 2), 8–15 are 256 << (code − 8)). */
const BLOCK_SIZE_CODE_192 = 1;
/** "Sample rate" header codes 12–14 are followed by the rate in 8 or 16 bits. */
const SAMPLE_RATE_CODE_8_BIT_KHZ = 12;
const SAMPLE_RATE_CODE_16_BIT_HZ = 13;
const SAMPLE_RATE_CODE_16_BIT_TENS_OF_HZ = 14;
/** "Sample size" header codes 0–7 (§9.1.4): bits per sample; code 0 means "as STREAMINFO says", 3 is reserved. */
const SAMPLE_SIZE_CODE_BITS = [0, 8, 12, 0, 16, 20, 24, 32];
const SAMPLE_SIZE_CODE_FROM_STREAMINFO = 0;
/** Channel assignments below this are plain independent channels (assignment + 1 of them). */
const FIRST_STEREO_DECORRELATION_ASSIGNMENT = 8;
/** Residual coding method 1 has 5-bit parameters, method 0 has 4-bit ones; the all-ones value escapes. */
const RICE_ESCAPE_METHOD_0 = 15;
const RICE_ESCAPE_METHOD_1 = 31;
/** Hex of an all-zero MD5, which STREAMINFO uses for "not computed". */
const UNSET_MD5 = '0'.repeat(32);
/** Samples hashed per step when checking the MD5 (keeps the temporary byte buffer small). */
const MD5_CHECK_BLOCK = 4096;

/** Decodes a FLAC stream (fixed or variable block size, every subframe type, CRCs checked). */
export function decodeFlac(bytes: Uint8Array): DecodedFlac {
  const reader = new BitReader(bytes);
  if (reader.read(32) !== FLAC_STREAM_MARKER) throw new FlacError('Not a FLAC file.');
  const info = readMetadata(reader, bytes);
  const channels = Array.from({ length: info.channelCount }, () => new Int32Array(info.totalSamples));
  let position = 0;
  while (position < info.totalSamples && reader.bytePos < bytes.length) {
    position += decodeFrame(reader, bytes, info, channels, position);
  }
  const md5Ok = info.md5Hex === UNSET_MD5 || md5HexOf(channels, info) === info.md5Hex;
  return { sampleRate: info.sampleRate, bitDepth: info.bitsPerSample, channels, md5: info.md5Hex, md5Ok };
}

/** Walks the metadata blocks (RFC 9639 §8), keeping what STREAMINFO says and skipping the rest. */
function readMetadata(reader: BitReader, bytes: Uint8Array): StreamInfo {
  let info: StreamInfo | null = null;
  for (let isLastBlock = false; !isLastBlock;) {
    isLastBlock = reader.read(1) === 1;
    const blockType = reader.read(7);
    const bodyLength = reader.read(24);
    const bodyStart = reader.bytePos;
    if (blockType === BLOCK_TYPE_STREAMINFO) info = readStreamInfo(reader, bytes);
    reader.seek(bodyStart + bodyLength);
  }
  if (!info || !info.sampleRate) throw new FlacError('FLAC file without STREAMINFO.');
  return info;
}

function readStreamInfo(reader: BitReader, bytes: Uint8Array): StreamInfo {
  reader.read(16); // minimum block size
  reader.read(16); // maximum block size
  reader.read(24); // minimum frame size
  reader.read(24); // maximum frame size
  const sampleRate = reader.read(20);
  const channelCount = reader.read(3) + 1;
  const bitsPerSample = reader.read(5) + 1;
  const totalSamples = reader.read(4) * 2 ** 32 + reader.read(32);
  const md5Bytes = bytes.subarray(reader.bytePos, reader.bytePos + MD5_BYTES);
  return { sampleRate, bitsPerSample, channelCount, totalSamples, md5Hex: toHex(md5Bytes) };
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Decodes one frame into `output` starting at sample `position`. Returns how many samples it holds
 * (the last frame may hold more than the stream's remaining length).
 */
function decodeFrame(
  reader: BitReader,
  bytes: Uint8Array,
  info: StreamInfo,
  output: Int32Array[],
  position: number,
): number {
  const frameStart = reader.bytePos;
  const header = readFrameHeader(reader, bytes, frameStart, info);
  const { blockSize, channelAssignment } = header;
  const subframes: Int32Array[] = [];
  const subframeCount = channelAssignment < FIRST_STEREO_DECORRELATION_ASSIGNMENT ? channelAssignment + 1 : 2;
  for (let c = 0; c < subframeCount; c++) {
    // The side channel of a decorrelated pair carries one extra bit per sample.
    const hasExtraBit =
      (channelAssignment === CHANNELS_LEFT_SIDE && c === 1) ||
      (channelAssignment === CHANNELS_SIDE_RIGHT && c === 0) ||
      (channelAssignment === CHANNELS_MID_SIDE && c === 1);
    subframes.push(readSubframe(reader, blockSize, header.bitsPerSample + (hasExtraBit ? 1 : 0)));
  }
  reader.alignByte();
  const expectedCrc = crc16(bytes, frameStart, reader.bytePos);
  if (reader.read(16) !== expectedCrc) throw new FlacError('FLAC frame CRC mismatch.');

  const sampleCount = Math.min(blockSize, info.totalSamples - position);
  copyDecorrelated(subframes, output, position, sampleCount, channelAssignment, info.channelCount);
  return sampleCount;
}

/** Reads a frame header (RFC 9639 §9.1) and checks its CRC-8. */
function readFrameHeader(reader: BitReader, bytes: Uint8Array, frameStart: number, info: StreamInfo): FrameHeader {
  if (reader.read(14) !== FRAME_SYNC_CODE) throw new FlacError('Lost FLAC frame sync.');
  reader.read(1); // reserved
  reader.read(1); // blocking strategy
  const blockSizeCode = reader.read(4);
  const sampleRateCode = reader.read(4);
  const channelAssignment = reader.read(4);
  const sampleSizeCode = reader.read(3);
  reader.read(1); // reserved
  reader.readUtf8(); // frame or sample number
  const blockSize = readBlockSize(reader, blockSizeCode);
  if (sampleRateCode === SAMPLE_RATE_CODE_8_BIT_KHZ) reader.read(8);
  else if (sampleRateCode === SAMPLE_RATE_CODE_16_BIT_HZ || sampleRateCode === SAMPLE_RATE_CODE_16_BIT_TENS_OF_HZ) {
    reader.read(16);
  }
  const bitsPerSample =
    sampleSizeCode === SAMPLE_SIZE_CODE_FROM_STREAMINFO
      ? info.bitsPerSample
      : (SAMPLE_SIZE_CODE_BITS[sampleSizeCode] as number);
  const expectedCrc = crc8(bytes, frameStart, reader.bytePos);
  if (reader.read(8) !== expectedCrc) throw new FlacError('FLAC frame header CRC mismatch.');
  return { blockSize, channelAssignment, bitsPerSample };
}

function readBlockSize(reader: BitReader, code: number): number {
  if (code === BLOCK_SIZE_CODE_192) return 192;
  if (code >= 2 && code <= 5) return 576 << (code - 2);
  if (code === BLOCK_SIZE_CODE_8_BIT) return reader.read(8) + 1;
  if (code === BLOCK_SIZE_CODE_16_BIT) return reader.read(16) + 1;
  if (code >= 8) return 256 << (code - 8);
  throw new FlacError('Reserved FLAC block size.');
}

/**
 * Undoes the channel decorrelation (§9.1.3) while copying a frame's subframes into the output:
 * left/side, side/right and mid/side each rebuild left and right; anything else is copied as is.
 */
function copyDecorrelated(
  subframes: Int32Array[],
  output: Int32Array[],
  position: number,
  sampleCount: number,
  channelAssignment: number,
  channelCount: number,
): void {
  for (let i = 0; i < sampleCount; i++) {
    if (channelAssignment === CHANNELS_LEFT_SIDE) {
      const left = subframes[0]![i]!;
      output[0]![position + i] = left;
      output[1]![position + i] = left - subframes[1]![i]!;
    } else if (channelAssignment === CHANNELS_SIDE_RIGHT) {
      const right = subframes[1]![i]!;
      output[0]![position + i] = subframes[0]![i]! + right;
      output[1]![position + i] = right;
    } else if (channelAssignment === CHANNELS_MID_SIDE) {
      const side = subframes[1]![i]!;
      // The encoder dropped mid's lowest bit (it equals side's); put it back before summing.
      const mid = subframes[0]![i]! * 2 + (side & 1);
      output[0]![position + i] = (mid + side) >> 1;
      output[1]![position + i] = (mid - side) >> 1;
    } else {
      for (let c = 0; c < channelCount; c++) output[c]![position + i] = subframes[c]![i]!;
    }
  }
}

/** MD5 (hex) of the decoded audio in STREAMINFO's form: interleaved little-endian samples. */
function md5HexOf(channels: Int32Array[], info: StreamInfo): string {
  const check = new Md5();
  const bytesPerSample = Math.ceil(info.bitsPerSample / 8);
  for (let start = 0; start < info.totalSamples; start += MD5_CHECK_BLOCK) {
    const count = Math.min(MD5_CHECK_BLOCK, info.totalSamples - start);
    const block = channels.map((c) => c.subarray(start, start + count));
    check.update(interleavedBytes(block, count, bytesPerSample));
  }
  return toHex(check.digest());
}

/** Decodes one subframe (§9.2) of `blockSize` samples of `bitsPerSample` bits. */
function readSubframe(reader: BitReader, blockSize: number, bitsPerSample: number): Int32Array {
  reader.read(1); // padding
  const type = reader.read(6);
  const wastedBits = reader.read(1) ? reader.readUnary() + 1 : 0;
  const bits = bitsPerSample - wastedBits;
  const samples = new Int32Array(blockSize);
  if (type === SUBFRAME_TYPE_CONSTANT) {
    samples.fill(reader.readSigned(bits));
  } else if (type === SUBFRAME_TYPE_VERBATIM) {
    for (let i = 0; i < blockSize; i++) samples[i] = reader.readSigned(bits);
  } else if (type >= SUBFRAME_TYPE_FIXED_BASE && type <= SUBFRAME_TYPE_FIXED_BASE + 4) {
    readFixedSubframe(reader, samples, type - SUBFRAME_TYPE_FIXED_BASE, bits);
  } else if (type >= SUBFRAME_TYPE_LPC_BASE) {
    readLpcSubframe(reader, samples, type - SUBFRAME_TYPE_LPC_BASE + 1, bits);
  } else {
    throw new FlacError(`Reserved FLAC subframe type ${type}.`);
  }
  if (wastedBits) {
    for (let i = 0; i < blockSize; i++) samples[i] = samples[i]! * 2 ** wastedBits;
  }
  return samples;
}

/** FIXED subframe: `order` warm-up samples, then residuals added to the polynomial prediction. */
function readFixedSubframe(reader: BitReader, x: Int32Array, order: number, bits: number): void {
  const blockSize = x.length;
  for (let i = 0; i < order; i++) x[i] = reader.readSigned(bits);
  readResidual(reader, blockSize, order, x);
  for (let i = order; i < blockSize; i++) {
    const residual = x[i]!;
    if (order === 1) x[i] = residual + x[i - 1]!;
    else if (order === 2) x[i] = residual + 2 * x[i - 1]! - x[i - 2]!;
    else if (order === 3) x[i] = residual + 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!;
    else if (order === 4) x[i] = residual + 4 * x[i - 1]! - 6 * x[i - 2]! + 4 * x[i - 3]! - x[i - 4]!;
  }
}

/** LPC subframe: warm-up samples, quantized coefficients, then residuals added to the prediction. */
function readLpcSubframe(reader: BitReader, x: Int32Array, order: number, bits: number): void {
  const blockSize = x.length;
  for (let i = 0; i < order; i++) x[i] = reader.readSigned(bits);
  const precision = reader.read(4) + 1;
  const shift = reader.readSigned(5);
  const coefficients: number[] = [];
  for (let j = 0; j < order; j++) coefficients.push(reader.readSigned(precision));
  readResidual(reader, blockSize, order, x);
  for (let i = order; i < blockSize; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += coefficients[j]! * x[i - 1 - j]!;
    x[i] = x[i]! + Math.floor(sum / 2 ** shift);
  }
}

/** Reads the partitioned Rice-coded residual (§9.2.7) into `x[order…)`. */
function readResidual(reader: BitReader, blockSize: number, order: number, x: Int32Array): void {
  const method = reader.read(2);
  if (method > 1) throw new FlacError('Reserved FLAC residual coding method.');
  const partitionOrder = reader.read(4);
  const partitionCount = 1 << partitionOrder;
  const partitionSize = blockSize >> partitionOrder;
  const parameterBits = method ? 5 : 4;
  const escapeParameter = method ? RICE_ESCAPE_METHOD_1 : RICE_ESCAPE_METHOD_0;
  let i = order;
  for (let p = 0; p < partitionCount; p++) {
    const k = reader.read(parameterBits);
    const sampleCount = p === 0 ? partitionSize - order : partitionSize;
    if (k === escapeParameter) {
      // Escape: the samples of this partition are plain signed numbers of the stated width.
      const rawBits = reader.read(5);
      for (let j = 0; j < sampleCount; j++) x[i++] = rawBits ? reader.readSigned(rawBits) : 0;
    } else {
      for (let j = 0; j < sampleCount; j++) {
        const zigzagged = reader.readUnary() * 2 ** k + (k ? reader.read(k) : 0);
        x[i++] = zigzagged % 2 ? -(zigzagged + 1) / 2 : zigzagged / 2;
      }
    }
  }
}
