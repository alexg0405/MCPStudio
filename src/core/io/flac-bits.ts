/**
 * Bit-level reading and writing for FLAC, most significant bit first. Both classes sit in the encoder's and
 * decoder's inner loops: they allocate nothing per call (the writer grows its buffer by doubling).
 */
import { FlacError } from './flac-format';

/** The most bits one write step handles: up to 7 bits still pending plus 24 new ones fit a 32-bit integer. */
const MAX_BITS_PER_STEP = 24;

/** Collects bits into a growing byte buffer. */
export class BitWriter {
  /** The buffer; only `bytes[0…bytePos)` holds written bytes. It is replaced when it grows. */
  bytes: Uint8Array;
  /** How many whole bytes have been written. */
  bytePos = 0;
  /** Bits written but not yet forming a whole byte. */
  private pendingBits = 0;
  private pendingBitCount = 0;

  constructor(capacityBytes: number) {
    this.bytes = new Uint8Array(capacityBytes);
  }

  /** Writes the low `bitCount` bits of `value` (up to 32). */
  write(value: number, bitCount: number): void {
    if (bitCount > MAX_BITS_PER_STEP) {
      // Two steps: the high part (above 24 bits) first, then the low 24 bits.
      this.write(
        Math.floor(value / 2 ** MAX_BITS_PER_STEP) & ((1 << (bitCount - MAX_BITS_PER_STEP)) - 1),
        bitCount - MAX_BITS_PER_STEP,
      );
      this.write(value & 0xffffff, MAX_BITS_PER_STEP);
      return;
    }
    if (bitCount === 0) return;
    this.pendingBits = (this.pendingBits << bitCount) | (value & ((1 << bitCount) - 1));
    this.pendingBitCount += bitCount;
    while (this.pendingBitCount >= 8) {
      this.pendingBitCount -= 8;
      this.pushByte((this.pendingBits >>> this.pendingBitCount) & 0xff);
    }
    this.pendingBits &= (1 << this.pendingBitCount) - 1;
  }

  /** Writes a two's-complement signed value in `bitCount` bits. */
  writeSigned(value: number, bitCount: number): void {
    const unsigned = value < 0 ? value + 2 ** bitCount : value;
    this.write(unsigned, bitCount);
  }

  /** Writes `u` as a Rice code: `u >> k` zero bits, a one bit, then the low `k` bits (RFC 9639 §9.2.7.1). */
  writeRice(u: number, k: number): void {
    let quotient = Math.floor(u / 2 ** k);
    while (quotient > MAX_BITS_PER_STEP) {
      this.write(0, MAX_BITS_PER_STEP);
      quotient -= MAX_BITS_PER_STEP;
    }
    this.write(1, quotient + 1);
    if (k > 0) this.write(u % 2 ** k, k);
  }

  /** Pads with zero bits up to the next byte boundary. */
  align(): void {
    if (this.pendingBitCount > 0) this.write(0, 8 - this.pendingBitCount);
  }

  /** Aligns and returns a copy of the bytes written. */
  finish(): Uint8Array {
    this.align();
    return this.bytes.slice(0, this.bytePos);
  }

  private pushByte(byte: number): void {
    if (this.bytePos === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.bytePos++] = byte;
  }
}

/** Reads bits from a byte array; throws a FlacError when the stream ends early. */
export class BitReader {
  /** Index of the byte being read. */
  bytePos = 0;
  /** Bits of the current byte already consumed (0–7). */
  private bitInByte = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** Reads an unsigned value of `bitCount` bits. */
  read(bitCount: number): number {
    let value = 0;
    for (let i = 0; i < bitCount; i++) {
      if (this.bytePos >= this.bytes.length) throw new FlacError('FLAC stream ends early.');
      const bit = ((this.bytes[this.bytePos] as number) >> (7 - this.bitInByte)) & 1;
      value = value * 2 + bit;
      if (++this.bitInByte === 8) {
        this.bitInByte = 0;
        this.bytePos++;
      }
    }
    return value;
  }

  /** Reads a two's-complement signed value of `bitCount` bits. */
  readSigned(bitCount: number): number {
    const unsigned = this.read(bitCount);
    return unsigned >= 2 ** (bitCount - 1) ? unsigned - 2 ** bitCount : unsigned;
  }

  /** Counts zero bits up to the next one bit (which is consumed). */
  readUnary(): number {
    let zeros = 0;
    while (this.read(1) === 0) zeros++;
    return zeros;
  }

  /** Reads the UTF-8-style coded frame or sample number of a frame header (RFC 9639 §9.1.5). */
  readUtf8(): number {
    const first = this.read(8);
    if (first < 0x80) return first;
    let byteCount = 0;
    while (first & (0x80 >> byteCount)) byteCount++;
    let value = first & ((1 << (7 - byteCount)) - 1);
    for (let i = 1; i < byteCount; i++) value = value * 64 + (this.read(8) & 0x3f);
    return value;
  }

  /** Skips to the next byte boundary. */
  alignByte(): void {
    if (this.bitInByte) {
      this.bitInByte = 0;
      this.bytePos++;
    }
  }

  /** Moves to the start of byte `byte`. */
  seek(byte: number): void {
    this.bytePos = byte;
    this.bitInByte = 0;
  }
}
