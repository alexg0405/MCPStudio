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
 * 4. Beat times refined between frames, BPM by a least-squares line through them (to 0.01, snapped
 *    to a whole number when that fits as well), and a drift check: when a fixed grid slips by more
 *    than 15 ms anywhere, the tracked beats are the answer.
 */
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

const median = (v: number[]): number => {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};

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

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

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

/** Least-squares line t = a + p·i through (i, t); returns [a, p]. */
function fitLine(idx: number[], t: number[]): [number, number] {
  const n = idx.length;
  const mi = mean(idx);
  const mt = mean(t);
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (idx[k]! - mi) * (t[k]! - mt);
    sxx += (idx[k]! - mi) ** 2;
  }
  const p = sxx > 0 ? sxy / sxx : 0;
  return [mt - p * mi, p];
}

/** Largest |running median over 9 beats| of the residuals. */
function slip(res: number[]): number {
  let worst = 0;
  for (let k = 0; k < res.length; k++) {
    const w = res.slice(Math.max(0, k - 4), Math.min(res.length, k + 5));
    worst = Math.max(worst, Math.abs(median(w)));
  }
  return worst;
}

export function trackBeats(f: OnsetFeatures): BeatTrack | null {
  const fr = f.frameRate;
  const o = prepared(f.onset);
  const fam = tempoFamily(o, fr);
  if (!fam) return null;
  let fast = fam.bpm;
  while (fast * 2 <= MAX_BPM) fast *= 2;
  let frames = dpBeats(o, (60 * fr) / fast);
  let bpm = fast;
  // Halve while the slower tempo explains the drums as well.
  while (bpm / 2 >= MIN_BPM && frames.length >= 8) {
    const d = preferFaster(f, o, frames, bpm);
    if (d.faster) break;
    frames = frames.filter((_, i) => i % 2 === d.parity);
    bpm /= 2;
  }
  frames = onTheBeat(f, frames);
  // Keep the beats between the first and the last real onset.
  let strength = frames.map((b) => peakNear(o, b));
  const typical = median(strength);
  if (!(typical > 0)) return null;
  let first = 0;
  let last = frames.length - 1;
  while (first < last && strength[first]! < 0.2 * typical) first++;
  while (last > first && strength[last]! < 0.2 * typical) last--;
  frames = frames.slice(first, last + 1);
  strength = strength.slice(first, last + 1);
  if (frames.length < 8) return null;
  // The flux of a hit that decays peaks a little before its attack reaches the frame centre.
  const times = frames.map((b) => refineFrame(o, b) / fr + ONSET_LAG);

  // Fixed grid through the beats that have an onset. The tracker can follow offbeats for a while
  // (an intro of offbeat hats) and then jump: fit the strongest stretch of evenly spaced beats first,
  // then every beat that lies on that line.
  const p0 = median(times.slice(1).map((t, i) => t - times[i]!));
  const isStrong = (k: number) => strength[k]! >= 0.35 * typical;
  let best: [number, number] = [0, times.length];
  let bestScore = -1;
  for (let a0 = 0; a0 < times.length; ) {
    let b0 = a0 + 1;
    while (b0 < times.length && Math.abs(times[b0]! - times[b0 - 1]! - p0) < 0.25 * p0) b0++;
    let sc = 0;
    for (let k = a0; k < b0; k++) if (isStrong(k)) sc += strength[k]!;
    if (sc > bestScore) {
      bestScore = sc;
      best = [a0, b0];
    }
    a0 = b0;
  }
  const seg: number[] = [];
  for (let k = best[0]; k < best[1]; k++) if (isStrong(k)) seg.push(k);
  let [a, p] = seg.length >= 4 ? fitLine(seg.map((k) => k - best[0]), seg.map((k) => times[k]!)) : [times[0]!, p0];
  const strong: number[] = [];
  for (let k = 0; k < times.length; k++) if (isStrong(k)) strong.push(k);
  let idx = strong.map((k) => Math.round((times[k]! - a) / p));
  let use = strong.map((_, j) => j).filter((j) => Math.abs(times[strong[j]!]! - (a + p * idx[j]!)) < 0.03);
  if (use.length < 8) return null;
  for (let pass = 0; pass < 2; pass++) {
    [a, p] = fitLine(
      use.map((j) => idx[j]!),
      use.map((j) => times[strong[j]!]!),
    );
    idx = strong.map((k) => Math.round((times[k]! - a) / p));
    const keep = strong.map((_, j) => j).filter((j) => Math.abs(times[strong[j]!]! - (a + p * idx[j]!)) < 0.03);
    if (keep.length < 8) break;
    use = keep;
  }
  const residuals = (aa: number, pp: number) => use.map((j) => times[strong[j]!]! - (aa + pp * idx[j]!));
  let res = residuals(a, p);
  let maxSlip = slip(res);
  let exact = 60 / p;
  // Most produced music sits on a whole BPM: take it when it fits as well.
  const whole = Math.round(exact);
  if (Math.abs(exact - whole) < 0.1) {
    const pw = 60 / whole;
    const aw = mean(use.map((j) => times[strong[j]!]! - pw * idx[j]!));
    const rw = residuals(aw, pw);
    const sw = slip(rw);
    // (a whole BPM that slips about as little as the best line does; a 127.95 song over minutes doesn't)
    if (sw <= Math.max(0.01, 1.4 * maxSlip)) {
      a = aw;
      p = pw;
      res = rw;
      maxSlip = sw;
      exact = whole;
    }
  }
  const drift = maxSlip > 0.015;
  const rms = Math.sqrt(mean(res.map((r) => r * r)));
  // How much the beats stand out of the onset envelope.
  let total = 0;
  const a0 = Math.max(0, Math.round(times[0]! * fr));
  const a1 = Math.min(o.length, Math.round(times[times.length - 1]! * fr) + 1);
  for (let i = a0; i < a1; i++) total += o[i]!;
  const background = total / Math.max(1, a1 - a0);
  const salience = mean(strength) / Math.max(1e-9, background);
  if (salience < 1.3) return null;
  // A pulse has hits on more than one beat of the bar (a pad struck once a bar doesn't make a beat).
  const byPos = [0, 1, 2, 3].map((r) => mean(strength.filter((_, k) => k % 4 === r)));
  const strongest = Math.max(...byPos);
  const hits = byPos.filter((x) => x >= 0.3 * strongest).length / 4;
  if (hits < 0.5) return null;
  const cSal = Math.max(0, Math.min(1, (salience - 1.3) / 2.5));
  const cFit = drift ? 0.35 : Math.exp(-((rms / 0.012) ** 2));
  // On a fixed grid the beats are the grid's, from the first to the last tracked beat.
  let beats: number[];
  let beatStrength = strength;
  if (drift) beats = smoothBeats(times, strength, typical);
  else {
    const k0 = Math.ceil((times[0]! - a) / p - 0.5);
    const k1 = Math.floor((times[times.length - 1]! - a) / p + 0.5);
    beats = [];
    for (let k = k0; k <= k1; k++) beats.push(a + k * p);
    beatStrength = beats.map((t) => peakNear(o, (t - ONSET_LAG) * fr));
  }
  return {
    bpm: Math.round(exact * 100) / 100,
    period: p,
    origin: a,
    beats,
    strength: beatStrength,
    drift,
    confidence: Math.round(cSal * cFit * 100) / 100,
    maxSlip,
  };
}

/** Tracked beats with their jitter smoothed: a local line through ±4 beats (beats with onsets count). */
function smoothBeats(times: number[], strength: number[], typical: number): number[] {
  return times.map((t, k) => {
    const idx: number[] = [];
    const ts: number[] = [];
    for (let j = Math.max(0, k - 4); j <= Math.min(times.length - 1, k + 4); j++)
      if (strength[j]! >= 0.35 * typical || j === k) {
        idx.push(j);
        ts.push(times[j]!);
      }
    if (idx.length < 3) return t;
    const [a, p] = fitLine(idx, ts);
    return a + p * k;
  });
}
