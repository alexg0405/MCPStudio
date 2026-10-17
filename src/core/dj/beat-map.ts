/**
 * A song's tracked beats as a clock (`TrackAnalysis.grid.beats`: one time per beat, for songs whose tempo drifts: a live
 * drummer, an old record). Between two beats the beat number moves linearly, so the phase is exact at every beat and
 * interpolated in between; the tempo is read from the beats around the position (a few beats averaged, then
 * interpolated, so it is smooth and does not jump at every beat). Beyond the first and last beat the nearest interval is
 * extended.
 *
 * Units are the caller's (seconds for the UI math, frames for the audio thread). Beat 0 is the beat at `origin` (the
 * first downbeat), so counting in bars or in half time lines up with the fixed grid's convention. The queries don't
 * allocate and remember the last bracket, so a playhead that moves steadily costs a step or two.
 */
export class BeatMap {
  private readonly t: Float64Array;
  /** The beat length around each beat, averaged over ±`SMOOTH` beats. */
  private readonly len: Float64Array;
  private readonly n: number;
  /** Index of the beat the first beat number counts from. */
  private readonly zero: number;
  private hint = 0;

  /**
   * `beats` ascending (a time that isn't after the one before is dropped); `origin` the time of beat 0 (the nearest beat
   * is taken as it). Needs at least two beats.
   */
  constructor(beats: ArrayLike<number>, origin = beats[0] ?? 0) {
    const kept: number[] = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i] as number;
      if (Number.isFinite(b) && (kept.length === 0 || b > (kept[kept.length - 1] as number))) kept.push(b);
    }
    if (kept.length < 2) throw new RangeError('BeatMap needs at least two beats.');
    this.n = kept.length;
    this.t = Float64Array.from(kept);
    const n = this.n;
    this.len = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - SMOOTH);
      const b = Math.min(n - 1, i + SMOOTH);
      this.len[i] = ((this.t[b] as number) - (this.t[a] as number)) / (b - a);
    }
    // The beat nearest the origin is beat 0.
    let z = 0;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs((this.t[i] as number) - origin);
      if (d < best) {
        best = d;
        z = i;
      }
    }
    this.zero = z;
  }

  get count(): number {
    return this.n;
  }

  /** The beat before-or-at `p` (clamped so there is always a beat after it to measure the interval to). */
  private bracket(p: number): number {
    const t = this.t;
    const last = this.n - 2;
    const i = this.hint > last ? last : this.hint;
    if (p < (t[i] as number)) {
      if (i === 0) return 0;
      if (p >= (t[i - 1] as number)) return (this.hint = i - 1);
    } else if (i === last || p < (t[i + 1] as number)) return i;
    else if (i + 1 === last || p < (t[i + 2] as number)) return (this.hint = i + 1);
    // A jump: bisect.
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((t[mid] as number) <= p) lo = mid;
      else hi = mid - 1;
    }
    return (this.hint = lo);
  }

  /** The beat number at `p`: whole at each beat, linear between them. */
  beatAt(p: number): number {
    const i = this.bracket(p);
    const t0 = this.t[i] as number;
    return i - this.zero + (p - t0) / ((this.t[i + 1] as number) - t0);
  }

  /** Where beat number `b` is (the inverse of `beatAt`). */
  posAt(b: number): number {
    const x = b + this.zero;
    let i = Math.floor(x);
    if (i < 0) i = 0;
    else if (i > this.n - 2) i = this.n - 2;
    const t0 = this.t[i] as number;
    return t0 + (x - i) * ((this.t[i + 1] as number) - t0);
  }

  /** The length of a beat at `p`: the beats around it averaged, interpolated between neighbouring beats. */
  lenAt(p: number): number {
    const i = this.bracket(p);
    const t0 = this.t[i] as number;
    let f = (p - t0) / ((this.t[i + 1] as number) - t0);
    if (f < 0) f = 0;
    else if (f > 1) f = 1;
    return (this.len[i] as number) * (1 - f) + (this.len[i + 1] as number) * f;
  }
}

/** Beats averaged each side when reading the tempo. */
const SMOOTH = 2;

/**
 * Beat times (seconds) of a song that starts at `bpm0` and drifts linearly to `bpm1` by `seconds`, one every beat from
 * `first`: what a tracker would report for a drummer slowly speeding up. For tests and demos.
 */
export function driftingBeats(bpm0: number, bpm1: number, seconds: number, first = 0): number[] {
  const out: number[] = [];
  // beats(t) = (bpm0·t + (bpm1 − bpm0)·t²/(2·seconds)) / 60: solve for t at each whole beat.
  const a = (bpm1 - bpm0) / (2 * seconds * 60);
  const b = bpm0 / 60;
  for (let k = 0; ; k++) {
    const t = a === 0 ? k / b : (-b + Math.sqrt(b * b + 4 * a * k)) / (2 * a);
    if (!Number.isFinite(t) || t > seconds) break;
    out.push(first + t);
  }
  return out;
}
