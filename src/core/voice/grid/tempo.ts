import type { VoiceEvent } from '../analyze';

/**
 * The tempo range, in beats per minute, the tempo guess searches; each field left out takes the default noted on it.
 */
export interface BpmOptions {
  /** Default 70. */
  min?: number;
  /** Default 180. */
  max?: number;
}

/** An onset time and how much it counts. */
interface WeightedOnset {
  t: number;
  w: number;
}

/** The autocorrelation is made in 1 ms bins up to this lag (s), with a Gaussian kernel of this width (s). */
const BIN_SEC = 0.001;
const MAX_LAG_SEC = 4.2;
const KERNEL_SIGMA_SEC = 0.008;
/** Onset pairs closer than this (s) are the same sound heard twice. */
const MIN_PAIR_LAG_SEC = 0.04;
/** A weak onset still counts a quarter; a full-strength one 1.25. */
const BASE_WEIGHT = 0.25;
/** Candidate tempos are tried in these steps (BPM). */
const BPM_STEP = 0.05;
/** The mild preference for ~110 BPM that settles double and half-time ties (a Gaussian in octaves). */
const PREFERRED_BPM = 110;
/** A score under this is no periodicity at all. */
const MIN_SCORE = 1e-6;
/** The refinement may move the tempo by at most this share. */
const MAX_REFINE_SHARE = 0.03;
/** Off-beat 8ths count as "as many" at this share of the beats' count, with this share of their strength, and lie this close to the 8th grid (in 8ths). */
const OFFBEAT_COUNT_SHARE = 0.75;
const OFFBEAT_STRENGTH_SHARE = 0.8;
const EIGHTH_GRID_TOLERANCE = 0.2;

/**
 * Lags in 1/16 notes and their weights: beat-level structure counts most; triplet lags count little.
 */
const LAGS: readonly (readonly [lags16th: number, weight: number])[] = [
  [1, 0.25],
  [2, 0.5],
  [4, 1],
  [8, 0.7],
  [16, 0.5],
  [3, 0.1],
  [6, 0.2],
  [12, 0.2],
];

/** The onset train's autocorrelation as a function of lag (s): onset pairs weighted by strength, spread with a Gaussian. */
function autocorrelationOf(ev: readonly WeightedOnset[]): (lag: number) => number {
  const bins = new Float64Array(Math.ceil(MAX_LAG_SEC / BIN_SEC) + 1);
  const reach = Math.ceil((3 * KERNEL_SIGMA_SEC) / BIN_SEC);
  for (let i = 0; i < ev.length; i++) {
    const a = ev[i] as WeightedOnset;
    for (let j = i + 1; j < ev.length; j++) {
      const b = ev[j] as WeightedOnset;
      const lag = b.t - a.t;
      if (lag > MAX_LAG_SEC - 3 * KERNEL_SIGMA_SEC) break;
      if (lag < MIN_PAIR_LAG_SEC) continue;
      const c = Math.round(lag / BIN_SEC);
      for (let k = Math.max(0, c - reach); k <= Math.min(bins.length - 1, c + reach); k++) {
        const d = (k * BIN_SEC - lag) / KERNEL_SIGMA_SEC;
        bins[k] = (bins[k] as number) + a.w * b.w * Math.exp(-0.5 * d * d);
      }
    }
  }
  return (lag) => {
    const x = lag / BIN_SEC;
    const k = Math.floor(x);
    if (k < 0 || k + 1 >= bins.length) return 0;
    return (bins[k] as number) + (x - k) * ((bins[k + 1] as number) - (bins[k] as number));
  };
}

/** The tempo in [min, max] whose 1/16, 1/8, beat, 2 beats and bar lags are the strongest, and its score. */
function bestTempo(at: (lag: number) => number, min: number, max: number): { best: number; bestScore: number } {
  let best = 0;
  let bestScore = 0;
  for (let bpm = min; bpm <= max + 1e-9; bpm += BPM_STEP) {
    const sixteenth = 60 / bpm / 4;
    let score = 0;
    for (const [m, w] of LAGS) score += w * at(m * sixteenth);
    score *= Math.exp(-0.5 * (Math.log2(bpm / PREFERRED_BPM) / 1) ** 2);
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return { best, bestScore };
}

/**
 * Octave check: when the winner's off-beat 8ths are as many and as strong as its beats, there is
 * no accent to say which are the beats (a steady pulse, unaccented hats): take double time.
 */
function prefersDoubleTime(events: readonly VoiceEvent[], ev: readonly WeightedOnset[], tempo: number): boolean {
  const eighth = 60 / tempo / 2;
  const phase = circularPhase(ev, eighth);
  const groups = [
    { n: 0, s: 0 },
    { n: 0, s: 0 },
  ];
  for (const e of events) {
    const x = (e.time - phase) / eighth;
    const k = Math.round(x);
    if (!Number.isFinite(x) || Math.abs(x - k) > EIGHTH_GRID_TOLERANCE) continue;
    const g = groups[k & 1] as { n: number; s: number };
    g.n++;
    g.s += Math.min(1, Math.max(0, e.strength));
  }
  const [on, off] = [...groups].sort((a, b) => b.s / Math.max(1, b.n) - a.s / Math.max(1, a.n)) as [
    { n: number; s: number },
    { n: number; s: number },
  ];
  return (
    off.n > 0 &&
    off.n >= OFFBEAT_COUNT_SHARE * on.n &&
    off.s / off.n >= OFFBEAT_STRENGTH_SHARE * (on.s / Math.max(1, on.n))
  );
}

/**
 * Refines a tempo by a least-squares fit of the onset times to integer 1/16 indices at that tempo;
 * kept only when it moves the tempo by under 3 % and stays in range.
 */
function refinedTempo(ev: readonly WeightedOnset[], tempo: number, min: number, max: number): number {
  const u = 60 / tempo / 4;
  const phase = circularPhase(ev, u);
  let n = 0;
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  for (const e of ev) {
    const k = Math.round((e.t - phase) / u);
    n += e.w;
    sk += e.w * k;
    st += e.w * e.t;
    skk += e.w * k * k;
    skt += e.w * k * e.t;
  }
  const den = n * skk - sk * sk;
  if (!(den > 0)) return tempo;
  const slope = (n * skt - sk * st) / den;
  const refined = 60 / (4 * slope);
  const isClose = Math.abs(refined - tempo) / tempo < MAX_REFINE_SHARE;
  return isClose && refined >= min - 1 && refined <= max + 1 ? refined : tempo;
}

/**
 * Tempo from the onsets: an autocorrelation of the onset train (pairs weighted by strength) is
 * scored at each candidate tempo's 1/16, 1/8, beat, 2 beats and bar (plus triplet lags at lower
 * weight), with a mild preference for ~110 BPM to settle double/half-time ties, then refined by a
 * least-squares fit of the onsets to that tempo's 1/16 grid. Null with fewer than three onsets or
 * no periodicity in range.
 */
export function estimateBpm(events: readonly VoiceEvent[], opts: BpmOptions = {}): number | null {
  const min = Math.max(1, opts.min ?? 70);
  const max = Math.max(min, opts.max ?? 180);
  const ev = events
    .filter((e) => Number.isFinite(e.time))
    .map((e) => ({ t: e.time, w: BASE_WEIGHT + Math.min(1, Math.max(0, e.strength)) }))
    .sort((a, b) => a.t - b.t);
  if (ev.length < 3) return null;
  const { best, bestScore } = bestTempo(autocorrelationOf(ev), min, max);
  if (!(bestScore > MIN_SCORE)) return null;
  const tempo = best * 2 <= max + 0.5 && prefersDoubleTime(events, ev, best) ? best * 2 : best;
  return Math.round(refinedTempo(ev, tempo, min, max) * 10) / 10;
}

/** Weighted circular mean of the onset times modulo `period`, in [0, period). */
function circularPhase(ev: readonly WeightedOnset[], period: number): number {
  let cx = 0;
  let cy = 0;
  for (const e of ev) {
    const a = (2 * Math.PI * e.t) / period;
    cx += e.w * Math.cos(a);
    cy += e.w * Math.sin(a);
  }
  return ((((Math.atan2(cy, cx) / (2 * Math.PI)) * period) % period) + period) % period;
}
