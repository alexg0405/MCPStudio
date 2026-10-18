/**
 * FLAC (Free Lossless Audio Codec) in pure TypeScript, no DOM: an encoder and a decoder for what it
 * writes (round-trip tests, reading FLAC samples). Everything else imports from here.
 *
 * - `flac-encoder.ts`: the stream and frame writer (`encodeFlac`, `FlacStreamEncoder`).
 * - `flac-subframes.ts`, `flac-rice.ts`: how one channel of a block is coded (predictors, Rice partitions).
 * - `flac-decoder.ts`: `decodeFlac`.
 * - `flac-format.ts`, `flac-bits.ts`: the format's constants and checksums, and the bit reader and writer.
 */
export { decodeFlac, type DecodedFlac } from './flac-decoder';
export {
  FlacStreamEncoder,
  encodeFlac,
  encodeFlacPcm,
  type EncodeFlacOptions,
  type FlacBitDepth,
} from './flac-encoder';
export { FlacError } from './flac-format';
