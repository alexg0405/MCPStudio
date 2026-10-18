/**
 * Tempo and beats from an onset envelope (`onset.ts`):
 *
 * 1. Tempo family: autocorrelation of the onset strength, scored by a comb (the lag and its
 *    multiples) over 60–200 BPM. That finds the pulse but not its octave.
 * 2. Beats at the fastest member of the family (≤ 200 BPM) by dynamic programming (Ellis 2007):
 *    each beat is an onset peak about one period after the previous one.
 * 3. Octave: halve while the slower tempo explains the drums as well (see `preferFaster`): kick and
 *    snare on its beats, no four-on-the-floor kick on its offbeats, no strong 8th-note pulse at the
 *    faster tempo. So house stays 128 (not 64), drum and bass 174 (not 87), trap 140 (its hats),
 *    boom bap 90 and reggaeton 100 (not 180/200).
 * 4. Beat times refined between frames, BPM by a least-squares line through them (beats far off the median-slope line are
 *    dropped first: a fill or the last beats of a section must not tilt it; to 0.01, snapped
 *    to a whole number when that fits as well), and a drift check: when a fixed grid slips by more
 *    than 15 ms anywhere, the tracked beats are the answer.
 */
import { fitFixedGrid, fitLine, gridResiduals, mean, median, slip, STRONG_BEAT_SHARE, type GridFit } from './beat-fit';
import type { OnsetFeatures } from './onset';

export interface BeatTrack {
  bpm: number;
  /** Seconds per beat of the fixed grid (60 / bpm before rounding). */
  period: number;
  /** A beat of the fixed grid (seconds): beats are at origin + k · period. */
  origin: number;
  /** Tracked beat times (seconds), refined; from the first to the last beat with an onset. */
  beats: number[];
  /** Onset strength at each tracked beat. */
  strength: number[];
  /** A fixed grid slips by more than 15 ms somewhere: use `beats`. */
  drift: boolean;
  /** 0–1. */
  confidence: number;
  /** Largest slip of the fixed grid against the tracked beats (seconds, smoothed over 9 beats). */
  maxSlip: number;
}

const MIN_BPM = 60;
const MAX_BPM = 200;
/** Seconds from where the onset envelope peaks to the attack (measured on synthetic drums). */
const ONSET_LAG = 0.008;

/** Linear interpolation of x at a fractional index (0 outside). */
function lerp(x: ArrayLike<number>, i: number): number {
  const a = Math.floor(i);
  if (a < 0 || a + 1 >= x.length) return 0;
  const f = i - a;
  return x[a]! * (1 - f) + x[a + 1]! * f;
}

/** Max of x within ±r frames of a fractional index. */
function peakNear(x: ArrayLike<number>, i: number, r = 2): number {
  const c = Math.round(i);
  let m = 0;
  for (let j = Math.max(0, c - r); j <= Math.min(x.length - 1, c + r); j++) if (x[j]! > m) m = x[j]!;
  return m;
}

/** Autocorrelation of the mean-removed envelope for lags 0..maxLag, normalized per lag. */
function autocorrelation(o: Float32Array, maxLag: number): Float64Array {
  const n = o.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += o[i]!;
  mean /= Math.max(1, n);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = o[i]! - mean;
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= Math.min(maxLag, n - 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i]! * x[i + lag]!;
    acf[lag] = s / (n - lag);
  }
  return acf;
}

/** The strongest pulse (BPM in 60–200) by a 4-harmonic comb over the autocorrelation. */
export function tempoFamily(o: Float32Array, frameRate: number): { bpm: number; salience: number } | null {
  const maxLag = Math.ceil((4 * 60 * frameRate) / MIN_BPM) + 2;
  if (o.length < 4 * frameRate) return null;
  const acf = autocorrelation(o, maxLag);
  if (!(acf[0]! > 0)) return null;
  let best = -Infinity;
  let bestBpm = 0;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM + 1e-9; bpm += 0.05) {
    const lag = (60 * frameRate) / bpm;
    let s = 0;
    for (let k = 1; k <= 4; k++) s += lerp(acf, k * lag);
    if (s > best) {
      best = s;
      bestBpm = bpm;
    }
  }
  if (!(best > 0)) return null;
  return { bpm: bestBpm, salience: best / (4 * acf[0]!) };
}

/** Beat frames by dynamic programming at a period of `tau` frames. */
function dpBeats(o: Float32Array, tau: number, tightness = 100): number[] {
  const n = o.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * tau);
  const hi = Math.max(1, Math.round(tau / 2));
  // Transition costs by distance (frames back).
  const cost = new Float64Array(lo + 1);
  for (let d = hi; d <= lo; d++) cost[d] = tightness * Math.log(d / tau) ** 2;
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let d = hi; d <= lo && t - d >= 0; d++) {
      const v = score[t - d]! - cost[d]!;
      if (arg < 0 || v > best) {
        best = v;
        arg = t - d;
      }
    }
    score[t] = o[t]! + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // The last beat: the best score within the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(tau)); t < n; t++) if (score[t]! > score[end]!) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) beats.push(t);
  return beats.reverse();
}

/** Smooths a copy of the onset envelope with [1, 2, 1] / 4 and scales it to unit spread. */
function prepared(o: Float32Array): Float32Array {
  const n = o.length;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.25 * (o[i - 1] ?? 0) + 0.5 * o[i]! + 0.25 * (o[i + 1] ?? 0);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s += y[i]!;
    s2 += y[i]! * y[i]!;
  }
  const sd = Math.sqrt(Math.max(1e-12, s2 / Math.max(1, n) - (s / Math.max(1, n)) ** 2));
  for (let i = 0; i < n; i++) y[i] = y[i]! / sd;
  return y;
}

/**
 * Whether the drums want `frames` (beats at the faster tempo F) rather than every other one of them
 * (S = F/2), and which parity S would keep (the one with more kick).
 */
export function preferFaster(
  f: OnsetFeatures,
  o: Float32Array,
  frames: number[],
  fastBpm: number,
): { faster: boolean; parity: 0 | 1 } {
  const kick = frames.map((b) => peakNear(f.low, b));
  // Snare: its crack (800 Hz–4 kHz) more than its body, which shares the low mids with the bass.
  const snare = frames.map((b) => 0.5 * peakNear(f.lowMid, b) + peakNear(f.highMid, b));
  const par = (v: number[], p: number) => mean(v.filter((_, i) => i % 2 === p));
  const parity: 0 | 1 = par(kick, 0) >= par(kick, 1) ? 0 : 1;
  const kOn = par(kick, parity);
  const kOff = par(kick, 1 - parity);
  const sOn = par(snare, parity);
  const sOff = par(snare, 1 - parity);
  // Hats on the beats of F and halfway between them.
  const hatOn = mean(frames.map((b) => peakNear(f.high, b)));
  const mids: number[] = [];
  for (let i = 0; i + 1 < frames.length; i++) mids.push(peakNear(f.high, (frames[i]! + frames[i + 1]!) / 2));
  const hatHalf = mean(mids);
  const slowBpm = fastBpm / 2;
  // Kick on every beat of F (four on the floor): S would put kicks on its offbeats. Only for a slow
  // S: above ~75 BPM, low-end hits between the beats are a bass line (boom bap), not a kick.
  if (fastBpm <= 150 && kOff >= 0.6 * kOn && kOn > 0) return { faster: true, parity };
  // The snare on the offbeats of a slow S (drum and bass two-step at 174 read as 87).
  if (slowBpm < 95 && sOff >= 1.3 * sOn && sOff > 0) return { faster: true, parity };
  // Hats on the 8ths of F: the faster tempo is the one that is felt (trap at 140, not 70).
  if (fastBpm <= 160 && hatHalf >= 0.2 * hatOn && hatHalf > 0.5) return { faster: true, parity };
  return { faster: false, parity };
}

/**
 * The biggest section start (frame): where the level rises most (> 8 dB) over a beat, not out of
 * silence, placed on the kick that starts it. Null when the song has no such jump.
 */
function biggestJump(f: OnsetFeatures, beatFrames: number): number | null {
  const n = f.power.length;
  let top = -Infinity;
  for (let i = 0; i < n; i++) top = Math.max(top, 10 * Math.log10(f.power[i]! + 1e-10));
  const floor = top - 50;
  const sum = new Float64Array(n + 1);
  // Frames near silence, counted: a rise out of a gap or the song's start isn't a section start.
  const quiet = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const d = 10 * Math.log10(f.power[i]! + 1e-10);
    sum[i + 1] = sum[i]! + Math.max(floor, d);
    quiet[i + 1] = quiet[i]! + (d < top - 45 ? 1 : 0);
  }
  const w = Math.max(2, Math.round(beatFrames));
  let best = -1;
  let bestRise = 8;
  for (let i = w; i + w <= n; i++) {
    const before = (sum[i]! - sum[i - w]!) / w;
    const after = (sum[i + w]! - sum[i]!) / w;
    if (quiet[i]! - quiet[i - w]! === 0 && before > top - 30 && after - before > bestRise) {
      bestRise = after - before;
      best = i;
    }
  }
  if (best < 0) return null;
  let at = best;
  const r = Math.round(w / 3);
  for (let j = Math.max(0, best - r); j < Math.min(n, best + r); j++) if (f.low[j]! + f.lowMid[j]! > f.low[at]! + f.lowMid[at]!) at = j;
  return at;
}

/**
 * The beats, or the points halfway between them when those are the real beats: offbeat hats and an
 * offbeat bass (house) can pull the tracker half a beat off. The biggest section start (the drop,
 * the drums coming in) decides first: it lands on a beat. Else where the kick, snare and bass weigh more.
 */
function onTheBeat(f: OnsetFeatures, frames: number[]): number[] {
  if (frames.length < 8) return frames;
  const mids = frames.slice(1).map((b, i) => Math.round((b + frames[i]!) / 2));
  const beat = median(frames.slice(1).map((b, i) => b - frames[i]!));
  const nearest = (pos: number[], t: number) => pos.reduce((m, x) => Math.min(m, Math.abs(x - t)), Infinity);
  const jump = biggestJump(f, beat);
  if (jump !== null) {
    const dOn = nearest(frames, jump);
    const dOff = nearest(mids, jump);
    if (Math.min(dOn, dOff) < beat / 6 && Math.abs(dOn - dOff) > beat / 4) return dOff < dOn ? mids : frames;
  }
  const body = (i: number) => peakNear(f.low, i) + peakNear(f.lowMid, i) + peakNear(f.highMid, i);
  const on = mean(frames.map(body));
  const off = mean(mids.map(body));
  return off > 1.15 * on ? mids : frames;
}

/** Sub-frame position of the onset peak within ±3 frames of a beat (the frame itself when there is none). */
function refineFrame(o: Float32Array, b: number): number {
  let best = b;
  for (let j = Math.max(1, b - 3); j <= Math.min(o.length - 2, b + 3); j++) if (o[j]! > o[best]!) best = j;
  if (best <= 0 || best >= o.length - 1 || !(o[best]! > 0)) return b;
  const a = o[best - 1]!;
  const c = o[best + 1]!;
  const m = o[best]!;
  const den = a - 2 * m + c;
  return best + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
}

/** Fewest beats a track needs to say anything about the tempo. */
const MIN_TRACKED_BEATS = 8;
/** Beats at the start and end whose onset is weaker than this share of the typical beat's are not real (the tracker ran on into silence). */
const WEAK_ONSET_SHARE = 0.2;
/** A fixed grid that slips more than this (seconds) against the tracked beats is a song with a drifting tempo. */
const DRIFT_SLIP_SEC = 0.015;
/** A BPM within this of a whole number may be snapped to it (music is mostly made at whole BPMs). */
const WHOLE_BPM_TOLERANCE = 0.1;
/** The whole BPM is taken when it slips less than this (seconds), or about as little as the fitted line: 1.4 times its slip. */
const WHOLE_BPM_FREE_SLIP_SEC = 0.02;
const WHOLE_BPM_SLIP_FACTOR = 1.4;
/** Beats must stand out of the onset envelope by this factor, or there is no beat to speak of. */
const MIN_SALIENCE = 1.3;
/** The salience range (above the minimum) that maps to confidence 0…1. */
const SALIENCE_RANGE = 2.5;
/** Beats per bar the pulse check looks at, and the share of the strongest position a position needs to count as hit. */
const BAR_POSITIONS = 4;
const BAR_HIT_SHARE = 0.3;
/** A pulse has hits on at least this share of the bar's beats (a pad struck once a bar doesn't make a beat). */
const MIN_BAR_HITS = 0.5;
/** Confidence of a drifting track (a fixed grid does not describe it), and the fit error (seconds) at which a fixed grid's confidence falls to 1/e. */
const DRIFT_FIT_CONFIDENCE = 0.35;
const FIT_ERROR_SCALE_SEC = 0.012;

/** Beat frames of the faster tempo, halved while the slower tempo explains the drums as well, and put on the real beats. Null when there is no pulse. */
function roughBeatFrames(f: OnsetFeatures, envelope: Float32Array): number[] | null {
  const frameRate = f.frameRate;
  const family = tempoFamily(envelope, frameRate);
  if (!family) return null;
  let fastBpm = family.bpm;
  while (fastBpm * 2 <= MAX_BPM) fastBpm *= 2;
  let frames = dpBeats(envelope, (60 * frameRate) / fastBpm);
  let bpm = fastBpm;
  // Halve while the slower tempo explains the drums as well.
  while (bpm / 2 >= MIN_BPM && frames.length >= MIN_TRACKED_BEATS) {
    const decision = preferFaster(f, envelope, frames, bpm);
    if (decision.faster) break;
    frames = frames.filter((_, i) => i % 2 === decision.parity);
    bpm /= 2;
  }
  return onTheBeat(f, frames);
}

/** Beats between the first and the last real onset, with their onset strengths and the typical strength. Null when too few remain. */
function keepBeatsWithOnsets(envelope: Float32Array, frames: number[]): { frames: number[]; strength: number[]; typical: number } | null {
  const strength = frames.map((b) => peakNear(envelope, b));
  const typical = median(strength);
  if (!(typical > 0)) return null;
  let first = 0;
  let last = frames.length - 1;
  while (first < last && strength[first]! < WEAK_ONSET_SHARE * typical) first++;
  while (last > first && strength[last]! < WEAK_ONSET_SHARE * typical) last--;
  if (last + 1 - first < MIN_TRACKED_BEATS) return null;
  return { frames: frames.slice(first, last + 1), strength: strength.slice(first, last + 1), typical };
}

/** A fixed grid, and the BPM it stands for. */
interface SnappedGrid {
  origin: number;
  period: number;
  residuals: number[];
  maxSlip: number;
  /** The tempo before rounding to 0.01: a whole BPM when that fits as well as the line. */
  bpm: number;
}

/**
 * The fitted grid as the BPM to report: most produced music sits on a whole BPM, so take it when it fits as well (a whole
 * BPM that slips about as little as the best line does; a 127.95 song over minutes doesn't. Under 20 ms the two can't be
 * told apart in a short clip, and whole is what music is made at).
 */
function snapToWholeBpm(fit: GridFit, times: number[]): SnappedGrid {
  let { origin, period } = fit;
  let residuals = gridResiduals(fit, times, origin, period);
  let maxSlip = slip(residuals);
  let bpm = 60 / period;
  const whole = Math.round(bpm);
  if (Math.abs(bpm - whole) < WHOLE_BPM_TOLERANCE) {
    const wholePeriod = 60 / whole;
    const wholeOrigin = mean(fit.use.map((j) => times[fit.strong[j]!]! - wholePeriod * fit.idx[j]!));
    const wholeResiduals = gridResiduals(fit, times, wholeOrigin, wholePeriod);
    const wholeSlip = slip(wholeResiduals);
    if (wholeSlip <= Math.max(WHOLE_BPM_FREE_SLIP_SEC, WHOLE_BPM_SLIP_FACTOR * maxSlip)) {
      origin = wholeOrigin;
      period = wholePeriod;
      residuals = wholeResiduals;
      maxSlip = wholeSlip;
      bpm = whole;
    }
  }
  return { origin, period, residuals, maxSlip, bpm };
}

/** How much the beats stand out of the onset envelope between the first and the last beat (their mean strength over the envelope's mean). */
function beatSalience(envelope: Float32Array, times: number[], strength: number[], frameRate: number): number {
  let total = 0;
  const first = Math.max(0, Math.round(times[0]! * frameRate));
  const end = Math.min(envelope.length, Math.round(times[times.length - 1]! * frameRate) + 1);
  for (let i = first; i < end; i++) total += envelope[i]!;
  const background = total / Math.max(1, end - first);
  return mean(strength) / Math.max(1e-9, background);
}

/** A pulse has hits on more than one beat of the bar (a pad struck once a bar doesn't make a beat). */
function hasBarPulse(strength: number[]): boolean {
  const byPosition = Array.from({ length: BAR_POSITIONS }, (_, position) => mean(strength.filter((_, k) => k % BAR_POSITIONS === position)));
  const strongest = Math.max(...byPosition);
  const hits = byPosition.filter((x) => x >= BAR_HIT_SHARE * strongest).length / BAR_POSITIONS;
  return hits >= MIN_BAR_HITS;
}

/** Tracks the beats of a song from its onset features: tempo, the beat times, a fixed grid or (for a drifting tempo) the tracked beats, and a confidence. Null when there is no steady beat. */
export function trackBeats(f: OnsetFeatures): BeatTrack | null {
  const frameRate = f.frameRate;
  const envelope = prepared(f.onset);
  const roughFrames = roughBeatFrames(f, envelope);
  if (!roughFrames) return null;
  const kept = keepBeatsWithOnsets(envelope, roughFrames);
  if (!kept) return null;
  const { frames, strength, typical } = kept;
  // The flux of a hit that decays peaks a little before its attack reaches the frame centre.
  const times = frames.map((b) => refineFrame(envelope, b) / frameRate + ONSET_LAG);

  const fit = fitFixedGrid(times, strength, typical);
  if (!fit) return null;
  const grid = snapToWholeBpm(fit, times);
  const { origin, period, maxSlip } = grid;
  const drift = maxSlip > DRIFT_SLIP_SEC;
  const rms = Math.sqrt(mean(grid.residuals.map((r) => r * r)));
  const salience = beatSalience(envelope, times, strength, frameRate);
  if (salience < MIN_SALIENCE) return null;
  if (!hasBarPulse(strength)) return null;
  const salienceConfidence = Math.max(0, Math.min(1, (salience - MIN_SALIENCE) / SALIENCE_RANGE));
  const fitConfidence = drift ? DRIFT_FIT_CONFIDENCE : Math.exp(-((rms / FIT_ERROR_SCALE_SEC) ** 2));
  // On a fixed grid the beats are the grid's, from the first to the last tracked beat.
  let beats: number[];
  let beatStrength = strength;
  if (drift) {
    beats = smoothBeats(times, strength, typical);
  } else {
    const firstBeat = Math.ceil((times[0]! - origin) / period - 0.5);
    const lastBeat = Math.floor((times[times.length - 1]! - origin) / period + 0.5);
    beats = [];
    for (let k = firstBeat; k <= lastBeat; k++) beats.push(origin + k * period);
    beatStrength = beats.map((t) => peakNear(envelope, (t - ONSET_LAG) * frameRate));
  }
  return {
    bpm: Math.round(grid.bpm * 100) / 100,
    period,
    origin,
    beats,
    strength: beatStrength,
    drift,
    confidence: Math.round(salienceConfidence * fitConfidence * 100) / 100,
    maxSlip,
  };
}
/** Tracked beats with their jitter smoothed: a local line through ±4 beats (beats with onsets count). */
function smoothBeats(times: number[], strength: number[], typical: number): number[] {
  return times.map((t, k) => {
    const idx: number[] = [];
    const ts: number[] = [];
    for (let j = Math.max(0, k - 4); j <= Math.min(times.length - 1, k + 4); j++)
      if (strength[j]! >= STRONG_BEAT_SHARE * typical || j === k) {
        idx.push(j);
        ts.push(times[j]!);
      }
    if (idx.length < 3) return t;
    const [a, p] = fitLine(idx, ts);
    return a + p * k;
  });
}
