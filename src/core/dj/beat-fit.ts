/**
 * Fitting a fixed beat grid (a line `time = origin + period · beat`) through tracked beat times, robustly: the tracker
 * can follow offbeats for a while and then jump, and a few beats that sit off the line (a fill, a break, the last beats
 * of a section) must not tilt the tempo. Used by `trackBeats` (`tempo.ts`).
 */

/** The middle value of a list (0 for none). */
export const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
};

/** The average of a list (0 for none). */
export const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** A beat counts as strong when its onset reaches this share of the typical beat's. */
export const STRONG_BEAT_SHARE = 0.35;

/** A beat lies on the grid when it is within this many seconds of its line (30 ms). */
const ON_LINE_TOLERANCE_SEC = 0.03;

/** Fewest beats a grid may be fitted through (fewer say nothing about the tempo). */
const MIN_FIT_BEATS = 8;

/** Beats are one stretch of a steady tempo while each gap is within this share of the median gap. */
const STEADY_GAP_SHARE = 0.25;

/** The fewest strong beats in the strongest stretch for it to give the first line. */
const MIN_STRETCH_BEATS = 4;

/** Refits through the beats on the line (the line moves a little when the off-line beats leave it). */
const REFIT_PASSES = 2;

/** The robust trim needs at least this many beats; it keeps at least 70 % of them and at least 8. */
const MIN_BEATS_FOR_ROBUST_TRIM = 12;
const MIN_TRIM_KEEP_SHARE = 0.7;

/** The robust trim drops beats beyond 3 robust sigmas (1.4826 · the median deviation), within these bounds (seconds). */
const MIN_TRIM_TOLERANCE_SEC = 0.008;
const TRIM_SIGMAS = 3;
const MEDIAN_ABS_TO_SIGMA = 1.4826;

/** Least-squares line t = a + p·i through (i, t); returns [a, p]. */
export function fitLine(idx: number[], t: number[]): [number, number] {
  const n = idx.length;
  const meanIndex = mean(idx);
  const meanTime = mean(t);
  let covariance = 0;
  let variance = 0;
  for (let k = 0; k < n; k++) {
    covariance += (idx[k]! - meanIndex) * (t[k]! - meanTime);
    variance += (idx[k]! - meanIndex) ** 2;
  }
  const period = variance > 0 ? covariance / variance : 0;
  return [meanTime - period * meanIndex, period];
}

/**
 * Line t = a + p·i by the median of the slopes between each beat and the one half the list later (a few outliers do not move
 * it, and a song of 15 000 beats costs 7 500 slopes, not 110 million); returns [a, p].
 */
export function theilSen(idx: number[], t: number[]): [number, number] {
  const slopes: number[] = [];
  const half = Math.max(1, idx.length >> 1);
  for (let i = 0; i + half < idx.length; i++) {
    if (idx[i + half]! !== idx[i]!) slopes.push((t[i + half]! - t[i]!) / (idx[i + half]! - idx[i]!));
  }
  const period = median(slopes);
  return [median(t.map((x, k) => x - period * idx[k]!)), period];
}

/** Largest |running median over 9 beats| of the residuals. */
export function slip(residuals: number[]): number {
  let worst = 0;
  for (let k = 0; k < residuals.length; k++) {
    const window = residuals.slice(Math.max(0, k - 4), Math.min(residuals.length, k + 5));
    worst = Math.max(worst, Math.abs(median(window)));
  }
  return worst;
}

/** A fixed grid fitted through beats: `time = origin + period · idx[j]` for the strong beats `strong[j]` listed in `use`. */
export interface GridFit {
  /** Seconds of beat 0 of the grid. */
  origin: number;
  /** Seconds per beat. */
  period: number;
  /** The strong beats (indices into the tracked beats). */
  strong: number[];
  /** The grid beat number of each strong beat. */
  idx: number[];
  /** Which of the strong beats (positions in `strong`) lie on the grid and were used to fit it. */
  use: number[];
}

/** The tracked beats with the start and end of the strongest steady stretch (beats whose gaps stay near `period`). */
function strongestSteadyStretch(times: number[], strength: number[], period: number, isStrong: (k: number) => boolean): [number, number] {
  let best: [number, number] = [0, times.length];
  let bestScore = -1;
  for (let start = 0; start < times.length; ) {
    let end = start + 1;
    while (end < times.length && Math.abs(times[end]! - times[end - 1]! - period) < STEADY_GAP_SHARE * period) end++;
    let score = 0;
    for (let k = start; k < end; k++) if (isStrong(k)) score += strength[k]!;
    if (score > bestScore) {
      bestScore = score;
      best = [start, end];
    }
    start = end;
  }
  return best;
}

/** The positions in `strong` of the beats within the tolerance of the grid line (`origin`, `period`). */
function beatsOnLine(times: number[], strong: number[], idx: number[], origin: number, period: number): number[] {
  return strong.map((_, j) => j).filter((j) => Math.abs(times[strong[j]!]! - (origin + period * idx[j]!)) < ON_LINE_TOLERANCE_SEC);
}

/**
 * Fits a fixed grid through the beats that have an onset. The tracker can follow offbeats for a while (an intro of
 * offbeat hats) and then jump: fit the strongest stretch of evenly spaced beats first, then every beat that lies on that
 * line, refit, and finally drop the beats that sit off the line by more than a few robust sigmas. Null when too few beats
 * lie on a line to say anything.
 *
 * `times` are the tracked beats in seconds, `strength` their onset strengths, `typical` the median strength.
 */
export function fitFixedGrid(times: number[], strength: number[], typical: number): GridFit | null {
  const firstPeriod = median(times.slice(1).map((t, i) => t - times[i]!));
  const isStrong = (k: number) => strength[k]! >= STRONG_BEAT_SHARE * typical;
  const [stretchStart, stretchEnd] = strongestSteadyStretch(times, strength, firstPeriod, isStrong);
  const stretch: number[] = [];
  for (let k = stretchStart; k < stretchEnd; k++) if (isStrong(k)) stretch.push(k);
  let [origin, period] =
    stretch.length >= MIN_STRETCH_BEATS
      ? fitLine(stretch.map((k) => k - stretchStart), stretch.map((k) => times[k]!))
      : [times[0]!, firstPeriod];
  const strong: number[] = [];
  for (let k = 0; k < times.length; k++) if (isStrong(k)) strong.push(k);
  let idx = strong.map((k) => Math.round((times[k]! - origin) / period));
  let use = beatsOnLine(times, strong, idx, origin, period);
  if (use.length < MIN_FIT_BEATS) return null;
  for (let pass = 0; pass < REFIT_PASSES; pass++) {
    [origin, period] = fitLine(use.map((j) => idx[j]!), use.map((j) => times[strong[j]!]!));
    idx = strong.map((k) => Math.round((times[k]! - origin) / period));
    const onLine = beatsOnLine(times, strong, idx, origin, period);
    if (onLine.length < MIN_FIT_BEATS) break;
    use = onLine;
  }
  // A few beats that sit off the line (a fill, a break, the last beats of a section) pull a least-squares slope, and so the BPM,
  // off by a tenth: take the median slope of the pairs as the first estimate, drop the beats beyond three robust sigmas
  // (at least 8 ms) of it while most of the beats stay, and fit the rest.
  if (use.length >= MIN_BEATS_FOR_ROBUST_TRIM) {
    const [robustOrigin, robustPeriod] = theilSen(use.map((j) => idx[j]!), use.map((j) => times[strong[j]!]!));
    const deviations = use.map((j) => times[strong[j]!]! - (robustOrigin + robustPeriod * idx[j]!));
    const tolerance = Math.min(ON_LINE_TOLERANCE_SEC, Math.max(MIN_TRIM_TOLERANCE_SEC, TRIM_SIGMAS * MEDIAN_ABS_TO_SIGMA * median(deviations.map(Math.abs))));
    const kept = use.filter((_, k) => Math.abs(deviations[k]!) <= tolerance);
    if (kept.length >= Math.max(MIN_FIT_BEATS, Math.ceil(MIN_TRIM_KEEP_SHARE * use.length)) && kept.length < use.length) {
      use = kept;
      [origin, period] = fitLine(use.map((j) => idx[j]!), use.map((j) => times[strong[j]!]!));
    }
  }
  return { origin, period, strong, idx, use };
}

/** The beat times' deviations from a grid line, over the beats the grid was fitted through. */
export function gridResiduals(fit: GridFit, times: number[], origin: number, period: number): number[] {
  return fit.use.map((j) => times[fit.strong[j]!]! - (origin + period * fit.idx[j]!));
}
