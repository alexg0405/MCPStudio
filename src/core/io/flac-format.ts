/**
 * The parts of the FLAC format (RFC 9639) that the encoder and the decoder share: its constants, the two
 * checksums and the error type. Field names follow the RFC so the code can be read next to it.
 */

/** Thrown for audio that is not valid FLAC (the decoder), or cannot be written as FLAC (never for valid input). */
export class FlacError extends Error {}

// --- Stream layout (RFC 9639 §6, §8) ------------------------------------------------------------

/** The four bytes "fLaC" that start every FLAC stream. */
export const FLAC_STREAM_MARKER = 0x664c6143;
/** Metadata block type 0: STREAMINFO, always the first block. */
export const BLOCK_TYPE_STREAMINFO = 0;
/**
 * STREAMINFO body size in bytes: min and max block size (16 + 16 bits), min and max frame size (24 + 24),
 * sample rate (20), channels − 1 (3), bits per sample − 1 (5), total samples (36), MD5 (128) = 272 bits.
 */
export const STREAMINFO_BODY_BYTES = 34;
/** The marker, one metadata block header (4 bytes) and the STREAMINFO body: what `header()` writes. */
export const STREAM_HEADER_BYTES = 4 + 4 + STREAMINFO_BODY_BYTES;
/** Where the 16-byte MD5 signature sits inside the stream header (after 18 bytes of other STREAMINFO fields). */
export const STREAMINFO_MD5_OFFSET = 4 + 4 + 18;
/** Bytes of the MD5 signature. */
export const MD5_BYTES = 16;

// --- Frame header (RFC 9639 §9.1) ---------------------------------------------------------------

/** The 14-bit synchronization code that starts every frame. */
export const FRAME_SYNC_CODE = 0b11111111111110;
/** "Block size" header codes (§9.1.1) that this code writes or needs to name. */
export const BLOCK_SIZE_CODE_4096 = 12; // 256 << (12 − 8)
/** Frame header block size code meaning "the block size minus one follows the header in 8 bits". */
export const BLOCK_SIZE_CODE_8_BIT = 6; // the size − 1 follows the header in 8 bits
/** Frame header block size code meaning "the block size minus one follows the header in 16 bits". */
export const BLOCK_SIZE_CODE_16_BIT = 7; // the size − 1 follows the header in 16 bits
/** "Sample rate" header codes (§9.1.2) for the rates that have one; others use 0 (read from STREAMINFO). */
export const SAMPLE_RATE_CODES: Record<number, number> = {
  88200: 1,
  176400: 2,
  192000: 3,
  8000: 4,
  16000: 5,
  22050: 6,
  24000: 7,
  32000: 8,
  44100: 9,
  48000: 10,
  96000: 11,
};
/** "Sample size" header codes (§9.1.4) for the two depths the encoder writes. */
export const SAMPLE_SIZE_CODE_16_BIT = 4;
/** Frame header sample size code for 24-bit audio. */
export const SAMPLE_SIZE_CODE_24_BIT = 6;

/** "Channel assignment" header codes (§9.1.3): 0–7 are that many + 1 independent channels. */
export const CHANNELS_LEFT_SIDE = 8;
/** Channel assignment code: two channels stored as side and right. */
export const CHANNELS_SIDE_RIGHT = 9;
/** Channel assignment code: two channels stored as mid and side. */
export const CHANNELS_MID_SIDE = 10;
/** Channel assignment code: two independent channels (left and right stored as they are). */
export const CHANNELS_INDEPENDENT_STEREO = 1;

// --- Subframes (RFC 9639 §9.2) ------------------------------------------------------------------

/** Subframe type numbers (§9.2.1). FIXED is 8 + order (0–4); LPC is 32 + order − 1 (1–32). */
export const SUBFRAME_TYPE_CONSTANT = 0;
/** Subframe type number for samples stored unpredicted, as they are. */
export const SUBFRAME_TYPE_VERBATIM = 1;
/** Base of the subframe type numbers of fixed predictors: this plus the order (0 to 4). */
export const SUBFRAME_TYPE_FIXED_BASE = 8;
/** Base of the subframe type numbers of LPC predictors: this plus the order minus 1 (orders 1 to 32). */
export const SUBFRAME_TYPE_LPC_BASE = 32;

/** The first byte of a subframe: a zero padding bit, the 6-bit type, and "no wasted bits" (a zero bit). */
export const subframeHeaderByte = (type: number): number => type << 1;

// --- Checksums (RFC 9639 §9.1.8, §9.3) ----------------------------------------------------------

const CRC8_TABLE = new Uint8Array(256);
const CRC16_TABLE = new Uint16Array(256);
// CRC-8 uses the polynomial x^8 + x^2 + x + 1 (0x07); CRC-16 uses x^16 + x^15 + x^2 + 1 (0x8005). Both start
// from 0 and are fed most significant bit first.
for (let byte = 0; byte < 256; byte++) {
  let crc8 = byte;
  for (let bit = 0; bit < 8; bit++) crc8 = crc8 & 0x80 ? ((crc8 << 1) ^ 0x07) & 0xff : (crc8 << 1) & 0xff;
  CRC8_TABLE[byte] = crc8;
  let crc16 = byte << 8;
  for (let bit = 0; bit < 8; bit++) crc16 = crc16 & 0x8000 ? ((crc16 << 1) ^ 0x8005) & 0xffff : (crc16 << 1) & 0xffff;
  CRC16_TABLE[byte] = crc16;
}

/** CRC-8 of `bytes[from…to)`: protects the frame header. */
export function crc8(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let i = from; i < to; i++) crc = CRC8_TABLE[crc ^ (bytes[i] as number)] as number;
  return crc;
}

/** CRC-16 of `bytes[from…to)`: protects a whole frame. */
export function crc16(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let i = from; i < to; i++) {
    crc = ((crc << 8) ^ (CRC16_TABLE[((crc >> 8) ^ (bytes[i] as number)) & 0xff] as number)) & 0xffff;
  }
  return crc;
}

/** Interleaved little-endian bytes of `count` samples of every channel: the form STREAMINFO's MD5 is taken over. */
export function interleavedBytes(channels: Int32Array[], count: number, bytesPerSample: number): Uint8Array {
  const out = new Uint8Array(count * channels.length * bytesPerSample);
  let at = 0;
  for (let i = 0; i < count; i++) {
    for (const channel of channels) {
      const sample = channel[i] as number;
      out[at++] = sample & 0xff;
      out[at++] = (sample >> 8) & 0xff;
      if (bytesPerSample === 3) out[at++] = (sample >> 16) & 0xff;
    }
  }
  return out;
}
