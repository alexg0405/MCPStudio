/**
 * What an export keeps of a render that arrives a piece at a time (renderStream): from where the
 * music is heard (after the pre-roll and the mixer's delay compensation) to the end of its tail
 * (the silence after the last audible sample off, plus 10 ms), the same cut as trimRender makes on
 * a whole buffer; or exactly `length` frames (stems share the mix's length). Only the tail after the
 * music is held back, until the end shows where the sound stops.
 */

/** Below this the tail counts as silence (-90 dBFS, under one 16-bit step). */
const SILENCE = 10 ** (-90 / 20);

export class StreamTrimmer {
  private emitted = 0;
  private held: Float32Array[][] = [];
  private heldFrames = 0;
  /** Export frame just after the last loud sample in the held tail. */
  private loudEnd = 0;

  /**
   * @param start render frame where the export begins
   * @param musicFrames frames of music always kept
   * @param opts.length a fixed length instead (padded with silence when the render is shorter)
   * @param opts.extra frames kept after the last audible sample (10 ms)
   */
  constructor(
    private readonly start: number,
    private readonly musicFrames: number,
    private readonly opts: { length?: number; extra: number },
  ) {}

  /** A piece of the render starting at render frame `frame`: the pieces to write now. */
  push(channels: Float32Array[], frame: number): Float32Array[][] {
    const n = channels[0]?.length ?? 0;
    // Into export frames.
    let a = frame - this.start;
    let piece = channels;
    if (a + n <= 0) return [];
    if (a < 0) {
      piece = channels.map((c) => c.subarray(-a));
      a = 0;
    }
    const len = piece[0]?.length ?? 0;
    if (this.opts.length !== undefined) {
      const room = this.opts.length - this.emitted;
      if (room <= 0) return [];
      const out = len > room ? piece.map((c) => c.subarray(0, room)) : piece;
      this.emitted += out[0]?.length ?? 0;
      return [out];
    }
    const out: Float32Array[][] = [];
    const musicLeft = this.musicFrames - a;
    if (musicLeft > 0) {
      const take = Math.min(len, musicLeft);
      out.push(take === len ? piece : piece.map((c) => c.subarray(0, take)));
      this.emitted += take;
      if (take === len) return out;
      piece = piece.map((c) => c.subarray(take));
      a += take;
    }
    // The tail: held until the end says how much of it is sound.
    const m = piece[0]?.length ?? 0;
    for (let i = m - 1; i >= 0; i--) {
      if (piece.some((c) => Math.abs(c[i] as number) > SILENCE)) {
        this.loudEnd = Math.max(this.loudEnd, a + i + 1);
        break;
      }
    }
    this.held.push(piece);
    this.heldFrames += m;
    return out;
  }

  /** The rest, once the render has ended (`renderFrames`: its length, in render frames). */
  finish(renderFrames: number): Float32Array[][] {
    const out: Float32Array[][] = [];
    const channels = this.held[0]?.length ?? 2;
    if (this.opts.length !== undefined) {
      const missing = this.opts.length - this.emitted;
      if (missing > 0) out.push(Array.from({ length: channels }, () => new Float32Array(missing)));
      this.emitted = this.opts.length;
      return out;
    }
    const total = Math.max(0, renderFrames - this.start);
    const end = Math.min(total, Math.max(this.musicFrames, this.loudEnd) + this.opts.extra);
    let left = end - this.emitted;
    for (const piece of this.held) {
      if (left <= 0) break;
      const n = Math.min(left, piece[0]?.length ?? 0);
      out.push(n === (piece[0]?.length ?? 0) ? piece : piece.map((c) => c.subarray(0, n)));
      left -= n;
      this.emitted += n;
    }
    this.held = [];
    this.heldFrames = 0;
    return out;
  }

  /** Frames written so far. */
  get frames(): number {
    return this.emitted;
  }
}
