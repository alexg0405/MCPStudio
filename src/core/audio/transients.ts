/**
 * Hits in recorded audio, for "Slice at transients" and source-tempo detection. Spectral flux on
 * log-compressed magnitudes (~5 ms hops), an adaptive threshold (moving median plus a margin the
 * sensitivity sets), peaks at least `minGap` apart; each hit is then placed just before its attack
 * on a 1 ms energy envelope, so a slice keeps the whole transient. Pure TypeScript, no DOM.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../voice/fft';

/**
 * Settings of transient detection: the range to search (seconds), how sensitive it is and the shortest gap between hits
 * (seconds).
 */
export interface TransientOptions {
  /** Seconds into the audio to look between (default: all of it). */
  from?: number;
  to?: number;
  /** 0–1 (default 0.5): higher finds softer hits. */
  sensitivity?: number;
  /** Shortest time between two hits, seconds (default 0.06). */
  minGap?: number;
}

interface Flux {
  /** Onset strength per hop. */
  values: Float64Array;
  /** Seconds per hop. */
  hop: number;
  /** Seconds of the first hop (`from`). */
  start: number;
  mono: Float32Array;
  monoStart: number;
}

/** The spectrum frames are 21 ms long (rounded up to a power of two samples), a quarter of that apart. */
const FRAME_SEC = 0.021;
/** The flux compresses magnitudes as log(1 + 100 × magnitude). */
const LOG_GAIN = 100;
/** The adaptive threshold's median is taken over ±0.1 s (at least ±2 hops). */
const MEDIAN_SEC = 0.1;
const MIN_MEDIAN_HALF = 2;
/** The margin over the median: (0.3 … 2.5) × the mean flux, wider at low sensitivity. */
const MARGIN_MIN = 0.3;
const MARGIN_RANGE = 2.2;
/** The floor under which a peak is ignored: (0.02 … 0.15) × the largest flux. */
const FLOOR_MIN = 0.02;
const FLOOR_RANGE = 0.13;
/** Loudness gate: a hit must reach −8 dB of the loudest at sensitivity 0 down to −40 dB at 1, within 30 ms of the hit. */
const GATE_DB_AT_ZERO = -8;
const GATE_DB_RANGE = 32;
const GATE_WINDOW_SEC = 0.03;
/** Shortest gap between two hits the caller may ask for, and the default (s). */
const MIN_GAP_FLOOR_SEC = 0.01;
const DEFAULT_MIN_GAP_SEC = 0.06;

function monoOf(channels: readonly Float32Array[], a: number, b: number): Float32Array {
  const n = Math.max(0, b - a);
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] = (out[i] as number) + ((c[a + i] as number) || 0);
  if (channels.length > 1) for (let i = 0; i < n; i++) out[i] = (out[i] as number) / channels.length;
  return out;
}

function spectralFlux(channels: readonly Float32Array[], sampleRate: number, from: number, to: number): Flux {
  const len = channels[0]?.length ?? 0;
  const a = Math.max(0, Math.min(len, Math.round(from * sampleRate)));
  const b = Math.max(a, Math.min(len, Math.round(to * sampleRate)));
  const mono = monoOf(channels, a, b);
  const size = nextPowerOfTwo(Math.round(FRAME_SEC * sampleRate));
  const hopN = size / 4;
  const fft = new RealFFT(size);
  const win = hannWindow(size);
  const mag = new Float64Array(fft.bins);
  const prev = new Float64Array(fft.bins);
  const frames = Math.max(0, Math.ceil(mono.length / hopN));
  const values = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    // Frames centred on their hop, so a hit's flux peaks where it happens.
    magnitudeSpectrum(fft, mono, f * hopN - size / 2, win, mag);
    let flux = 0;
    for (let k = 1; k < fft.bins; k++) {
      const v = Math.log1p(LOG_GAIN * (mag[k] as number));
      const d = v - (prev[k] as number);
      if (d > 0) flux += d;
      prev[k] = v;
    }
    values[f] = f === 0 ? 0 : flux;
  }
  return { values, hop: hopN / sampleRate, start: a / sampleRate, mono, monoStart: a };
}

function movingMedian(x: Float64Array, half: number): Float64Array {
  const out = new Float64Array(x.length);
  const buf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(x.length - 1, i + half); j++) buf.push(x[j] as number);
    buf.sort((p, q) => p - q);
    out[i] = buf[buf.length >> 1] as number;
  }
  return out;
}

/**
 * The hop indices of flux peaks that stand out of their surroundings (over the floor and over the moving median
 * plus a margin) and are at least `gapFrames` apart (of two close ones the stronger stays); empty for silence.
 */
function fluxPeaks(flux: Flux, sensitivity: number, gapFrames: number): number[] {
  const v = flux.values;
  let max = 0;
  let mean = 0;
  for (const x of v) {
    max = Math.max(max, x);
    mean += x;
  }
  mean /= v.length;
  if (max <= 0) return [];
  const median = movingMedian(v, Math.max(MIN_MEDIAN_HALF, Math.round(MEDIAN_SEC / flux.hop)));
  const margin = (MARGIN_MIN + MARGIN_RANGE * (1 - sensitivity)) * mean;
  const floor = (FLOOR_MIN + FLOOR_RANGE * (1 - sensitivity)) * max;
  const peaks: number[] = [];
  for (let i = 1; i < v.length - 1; i++) {
    const x = v[i] as number;
    if (x < floor || x < (median[i] as number) + margin) continue;
    if (x < (v[i - 1] as number) || x < (v[i + 1] as number)) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < gapFrames) {
      if (x > (v[last] as number)) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

/** Times (seconds from the start of the audio) where hits begin, ascending. */
export function detectTransients(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: TransientOptions = {},
): number[] {
  const len = channels[0]?.length ?? 0;
  if (len === 0) return [];
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(len / sampleRate, opts.to ?? len / sampleRate);
  const sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5));
  const minGap = Math.max(MIN_GAP_FLOOR_SEC, opts.minGap ?? DEFAULT_MIN_GAP_SEC);
  const flux = spectralFlux(channels, sampleRate, from, to);
  if (flux.values.length < 3) return [];
  const gapFrames = Math.max(1, Math.round(minGap / flux.hop));
  const peaks = fluxPeaks(flux, sensitivity, gapFrames);
  // Loudness gate: a hit must reach a level the sensitivity sets (−8 dB of the loudest at 0, −40 dB at 1).
  const mono = flux.mono;
  let loudest = 0;
  for (let i = 0; i < mono.length; i++) loudest = Math.max(loudest, Math.abs(mono[i] as number));
  const gate = loudest * Math.pow(10, (GATE_DB_AT_ZERO - GATE_DB_RANGE * sensitivity) / 20);
  const out: number[] = [];
  let prev = -Infinity;
  for (const i of peaks) {
    const t = refine(flux, sampleRate, flux.start + i * flux.hop, prev);
    const a = Math.round((t - flux.start) * sampleRate);
    let level = 0;
    for (let j = a; j < Math.min(mono.length, a + Math.round(GATE_WINDOW_SEC * sampleRate)); j++) {
      level = Math.max(level, Math.abs(mono[j] as number));
    }
    if (level < gate || t <= prev) continue;
    out.push(t);
    prev = t;
  }
  return out;
}

/**
 * Moves a hit to just before its attack: where the 1 ms envelope first gets near the peak that
 * follows, looking back no further than the previous hit.
 */
function refine(flux: Flux, sampleRate: number, t: number, after: number): number {
  const block = Math.max(1, Math.round(0.001 * sampleRate));
  const centre = Math.round((t - flux.start) * sampleRate);
  const earliest = Number.isFinite(after) ? Math.round((after - flux.start) * sampleRate) + 5 * block : 0;
  const a = Math.max(0, earliest, centre - Math.round(0.03 * sampleRate));
  const b = Math.min(flux.mono.length, centre + Math.round(0.02 * sampleRate));
  const env: number[] = [];
  for (let i = a; i < b; i += block) {
    let m = 0;
    for (let j = i; j < Math.min(b, i + block); j++) m = Math.max(m, Math.abs(flux.mono[j] as number));
    env.push(m);
  }
  if (env.length === 0) return t;
  // The attack: the biggest jump of the envelope over ~3 ms (it works on another hit's tail too)…
  let attack = 0;
  let jump = -Infinity;
  for (let k = 1; k < env.length; k++) {
    let low = env[k - 1] as number;
    for (let j = Math.max(0, k - 3); j < k; j++) low = Math.min(low, env[j] as number);
    const d = (env[k] as number) - low;
    if (d > jump) {
      jump = d;
      attack = k;
    }
  }
  // …then back to where it starts rising, one block early so the slice keeps the whole hit.
  let rise = attack;
  while (rise > 0 && (env[rise - 1] as number) < (env[rise] as number)) rise--;
  const at = a + Math.max(0, rise - 1) * block;
  return Math.max(flux.start, (flux.monoStart + at) / sampleRate);
}

/** The tempo range detected (BPM), and the octave a reading is nudged into. */
const MIN_BPM = 60;
const MAX_BPM = 200;
const PREFERRED_MIN_BPM = 80;
const PREFERRED_MAX_BPM = 160;
const PREFERRED_OCTAVE_BONUS = 1.15;
/** Bar counts a loop is checked against. */
const LOOP_BARS = [1, 2, 4, 8, 16, 32];

/** How close (as a share of the estimate) the tempo a loop's length gives must be to take over, and for the dotted reading. */
const LENGTH_FIT_TOLERANCE = 0.04;
const DOTTED_FIT_TOLERANCE = 0.012;

/**
 * The lag (in hops) of the strongest autocorrelation of the onset strength over lags of 0.3–1 s (60–200 BPM), with
 * the 80–160 BPM octave preferred a little, refined by a parabola through its neighbours; null when nothing repeats.
 */
function strongestPulseLag(values: Float64Array, hop: number): number | null {
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const x = Array.from(values, (y) => Math.max(0, y - mean));
  const lag0 = Math.floor(60 / MAX_BPM / hop);
  const lag1 = Math.ceil(60 / MIN_BPM / hop);
  let best = -1;
  let bestScore = 0;
  const scores = new Map<number, number>();
  for (let lag = lag0; lag <= Math.min(lag1, x.length - 2); lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += (x[i] as number) * (x[i + lag] as number);
    s /= x.length - lag;
    scores.set(lag, s);
    // Prefer the 80–160 BPM octave a little.
    const bpm = 60 / (lag * hop);
    const w = bpm >= PREFERRED_MIN_BPM && bpm <= PREFERRED_MAX_BPM ? PREFERRED_OCTAVE_BONUS : 1;
    if (s * w > bestScore) {
      bestScore = s * w;
      best = lag;
    }
  }
  if (best < 0 || !(bestScore > 0)) return null;
  // Parabolic refinement of the peak lag.
  const a = scores.get(best - 1) ?? 0;
  const b = scores.get(best) ?? 0;
  const c = scores.get(best + 1) ?? 0;
  const den = a - 2 * b + c;
  return best + (den !== 0 ? (0.5 * (a - c)) / den : 0);
}

/**
 * A loop of whole bars at a nearby tempo: its length is the better measure (exact for loops). Tried at the estimate,
 * double and half of it; then a syncopated pattern (a bass on dotted eighths, a three-over-two hat) repeats every
 * 1.5 beats, so the pulse found is 2/3 of the tempo: a loop that is whole bars at 1.5 × the estimate is read that way
 * (checked after the plain fits, so a loop that fits at the estimate itself keeps it). Null when none fits.
 */
function tempoFromLength(estimate: number, duration: number, beatsPerBar: number): number | null {
  for (const bars of LOOP_BARS) {
    const bpm = (60 * bars * beatsPerBar) / duration;
    for (const m of [1, 2, 0.5]) {
      const fits = Math.abs(bpm * m - estimate) / estimate < LENGTH_FIT_TOLERANCE;
      if (fits && bpm * m >= MIN_BPM && bpm * m <= MAX_BPM) return Math.round(bpm * m * 100) / 100;
    }
  }
  for (const bars of LOOP_BARS) {
    const bpm = (60 * bars * beatsPerBar) / duration;
    const fits = Math.abs(bpm - estimate * 1.5) / (estimate * 1.5) < DOTTED_FIT_TOLERANCE;
    if (fits && bpm >= MIN_BPM && bpm <= MAX_BPM) return Math.round(bpm * 100) / 100;
  }
  return null;
}

/**
 * The tempo a loop or recording was played at (BPM, 60–200), from how regularly its hits repeat;
 * when the length fits a whole number of bars near that tempo, the length decides (exact for
 * loops). Null when there is no clear pulse.
 */
export function detectTempo(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: { beatsPerBar?: number } = {},
): number | null {
  const len = channels[0]?.length ?? 0;
  const duration = len / sampleRate;
  if (duration < 1) return null;
  // A one-shot (a crash, a vocal phrase) has no pulse to read.
  if (detectTransients(channels, sampleRate).length < 4) return null;
  const flux = spectralFlux(channels, sampleRate, 0, duration);
  const lag = strongestPulseLag(flux.values, flux.hop);
  if (lag === null) return null;
  const estimate = 60 / (lag * flux.hop);
  const fromLength = tempoFromLength(estimate, duration, opts.beatsPerBar ?? 4);
  return fromLength ?? Math.round(estimate * 10) / 10;
}
