// Sample playback at any speed. Allocation-free; usable on any thread.

const EMPTY = new Float32Array(1);

/**
 * Plays frames `[start, end)` of a mono or stereo sample at any speed (source frames per output
 * frame: pitch × source rate / output rate), forwards or backwards, with linear interpolation.
 * `next()` advances one output frame and leaves the values in `l` and `r` (a mono sample gives the
 * same value in both); it returns false, and `active` turns false, after the last frame.
 */
export class SampleReader {
  l = 0;
  r = 0;
  active = false;
  private left: Float32Array = EMPTY;
  private right: Float32Array = EMPTY;
  private pos = 0;
  private step = 1;
  private start = 0;
  private end = 0;
  private reverse = false;

  play(channels: readonly Float32Array[], start: number, end: number, speed: number, reverse = false): void {
    const left = channels[0];
    if (!left || left.length === 0 || !(speed > 0)) {
      this.active = false;
      return;
    }
    this.left = left;
    this.right = channels[1] ?? left;
    this.start = Math.max(0, Math.min(left.length, Math.floor(start)));
    this.end = Math.max(this.start, Math.min(left.length, Math.ceil(end)));
    this.step = speed;
    this.reverse = reverse;
    this.pos = reverse ? this.end - 1 : this.start;
    this.active = this.end > this.start;
    this.l = 0;
    this.r = 0;
  }

  /** Changes the speed of a playing sample (pitch bends). */
  setSpeed(speed: number): void {
    if (speed > 0) this.step = speed;
  }

  /** Output frames left at the current speed. */
  get remaining(): number {
    if (!this.active) return 0;
    return Math.max(0, this.reverse ? this.pos - this.start + 1 : this.end - this.pos) / this.step;
  }

  /** Where it is, as a fraction of the region played (0 at the start, 1 at the end). */
  get progress(): number {
    const len = this.end - this.start;
    if (len <= 0) return 1;
    return this.reverse ? (this.end - 1 - this.pos) / len : (this.pos - this.start) / len;
  }

  next(): boolean {
    if (!this.active) {
      this.l = 0;
      this.r = 0;
      return false;
    }
    const pos = this.pos;
    const i = Math.floor(pos);
    const f = pos - i;
    const last = this.end - 1;
    const j = i + 1 > last ? last : i + 1;
    const L = this.left;
    const R = this.right;
    const a = L[i] as number;
    this.l = a + ((L[j] as number) - a) * f;
    const b = R[i] as number;
    this.r = b + ((R[j] as number) - b) * f;
    if (this.reverse) {
      this.pos = pos - this.step;
      if (this.pos < this.start) this.active = false;
    } else {
      this.pos = pos + this.step;
      if (this.pos >= this.end) this.active = false;
    }
    return true;
  }

  stop(): void {
    this.active = false;
    this.l = 0;
    this.r = 0;
  }
}
