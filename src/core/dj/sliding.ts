/**
 * Small pieces the streaming analysis is built from (pure, no DOM): a window over a signal that arrives in
 * pieces and is forgotten as it is used, and a float array that grows without doubling past what is known.
 */

/**
 * The most recent stretch of a signal fed in pieces: `append` adds samples, `view` reads them by absolute position
 * (`base` is the position of its first sample), `discardBefore` forgets what is no longer needed. Memory stays at
 * the longest span kept plus one piece, however long the signal is.
 */
export class SlidingBuffer {
  private buf: Float32Array;
  private len = 0;
  /** Absolute position of the first kept sample. */
  base = 0;

  constructor(capacity: number) {
    this.buf = new Float32Array(Math.max(16, capacity));
  }

  /** Samples fed so far (absolute position after the last one). */
  get end(): number {
    return this.base + this.len;
  }

  append(x: ArrayLike<number>, n = x.length): void {
    if (this.len + n > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + n));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    if (x instanceof Float32Array) this.buf.set(n === x.length ? x : x.subarray(0, n), this.len);
    else for (let i = 0; i < n; i++) this.buf[this.len + i] = x[i] as number;
    this.len += n;
  }

  /** The kept samples: index 0 is absolute position `base`. Valid until the next append or discard. */
  view(): Float32Array {
    return this.buf.subarray(0, this.len);
  }

  /** Forgets everything before absolute position `pos` (nothing when it is not past `base`). */
  discardBefore(pos: number): void {
    const drop = Math.min(this.len, Math.floor(pos) - this.base);
    if (drop <= 0) return;
    this.buf.copyWithin(0, drop, this.len);
    this.len -= drop;
    this.base += drop;
  }
}

/** A Float32Array that holds `expected` values to begin with and doubles only if there turn out to be more. */
export class GrowF32 {
  data: Float32Array;
  length = 0;

  constructor(expected = 1024) {
    this.data = new Float32Array(Math.max(16, expected));
  }

  push(v: number): void {
    if (this.length === this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = v;
  }

  private grow(min: number): void {
    const next = new Float32Array(Math.max(min, Math.ceil(this.data.length * 1.5)));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  /** The values as an array of exactly `length` (no copy when the capacity is that already). */
  finish(): Float32Array {
    return this.length === this.data.length ? this.data : this.data.slice(0, this.length);
  }
}

const BLOCK_BITS = 16;
const BLOCK_MASK = (1 << BLOCK_BITS) - 1;

/** Float32 values kept in blocks (never one big array to grow): the peaks of a whole song, 8 bytes apiece. */
export class BlockedF32 {
  private readonly blocks: Float32Array[] = [];
  length = 0;

  push(v: number): void {
    const b = this.length >> BLOCK_BITS;
    if (b === this.blocks.length) this.blocks.push(new Float32Array(1 << BLOCK_BITS));
    (this.blocks[b] as Float32Array)[this.length & BLOCK_MASK] = v;
    this.length++;
  }

  at(i: number): number {
    return (this.blocks[i >> BLOCK_BITS] as Float32Array)[i & BLOCK_MASK] as number;
  }

  get bytes(): number {
    return this.blocks.length * (4 << BLOCK_BITS);
  }
}

/** Small integers kept in blocks, like `BlockedF32`. */
export class BlockedU8 {
  private readonly blocks: Uint8Array[] = [];
  length = 0;

  push(v: number): void {
    const b = this.length >> BLOCK_BITS;
    if (b === this.blocks.length) this.blocks.push(new Uint8Array(1 << BLOCK_BITS));
    (this.blocks[b] as Uint8Array)[this.length & BLOCK_MASK] = v;
    this.length++;
  }

  at(i: number): number {
    return (this.blocks[i >> BLOCK_BITS] as Uint8Array)[i & BLOCK_MASK] as number;
  }

  get bytes(): number {
    return this.blocks.length << BLOCK_BITS;
  }
}
