/**
 * Hits in recorded audio, for "Slice at transients" and source-tempo detection. Spectral flux on
 * log-compressed magnitudes (~5 ms hops), an adaptive threshold (moving median plus a margin the
 * sensitivity sets), peaks at least `minGap` apart; each hit is then placed just before its attack
 * on a 1 ms energy envelope, so a slice keeps the whole transient. Pure TypeScript, no DOM.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../voice/fft';

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
  const size = nextPowerOfTwo(Math.round(0.021 * sampleRate));
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
      const v = Math.log1p(100 * (mag[k] as number));
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
  const minGap = Math.max(0.01, opts.minGap ?? 0.06);
  const flux = spectralFlux(channels, sampleRate, from, to);
  const v = flux.values;
  if (v.length < 3) return [];
  let max = 0;
  let mean = 0;
  for (const x of v) {
    max = Math.max(max, x);
    mean += x;
  }
  mean /= v.length;
  if (max <= 0) return [];
  const median = movingMedian(v, Math.max(2, Math.round(0.1 / flux.hop)));
  const margin = (0.3 + 2.2 * (1 - sensitivity)) * mean;
  const floor = (0.02 + 0.13 * (1 - sensitivity)) * max;
  const gapFrames = Math.max(1, Math.round(minGap / flux.hop));
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
  // Loudness gate: a hit must reach a level the sensitivity sets (−8 dB of the loudest at 0, −40 dB at 1).
  const mono = flux.mono;
  let loudest = 0;
  for (let i = 0; i < mono.length; i++) loudest = Math.max(loudest, Math.abs(mono[i] as number));
  const gate = loudest * Math.pow(10, (-8 - 32 * sensitivity) / 20);
  const out: number[] = [];
  let prev = -Infinity;
  for (const i of peaks) {
    const t = refine(flux, sampleRate, flux.start + i * flux.hop, prev);
    const a = Math.round((t - flux.start) * sampleRate);
    let level = 0;
    for (let j = a; j < Math.min(mono.length, a + Math.round(0.03 * sampleRate)); j++)
      level = Math.max(level, Math.abs(mono[j] as number));
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
  const v = flux.values;
  // Autocorrelation of the onset strength over lags of 0.3–1 s (60–200 BPM).
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const x = Array.from(v, (y) => Math.max(0, y - mean));
  const lag0 = Math.floor(60 / 200 / flux.hop);
  const lag1 = Math.ceil(60 / 60 / flux.hop);
  let best = -1;
  let bestScore = 0;
  const scores = new Map<number, number>();
  for (let lag = lag0; lag <= Math.min(lag1, x.length - 2); lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += (x[i] as number) * (x[i + lag] as number);
    s /= x.length - lag;
    scores.set(lag, s);
    // Prefer the 80–160 BPM octave a little.
    const bpm = 60 / (lag * flux.hop);
    const w = bpm >= 80 && bpm <= 160 ? 1.15 : 1;
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
  const lag = best + (den !== 0 ? (0.5 * (a - c)) / den : 0);
  const estimate = 60 / (lag * flux.hop);
  // A loop of whole bars at a nearby tempo: its length is the better measure.
  const perBar = opts.beatsPerBar ?? 4;
  for (const bars of [1, 2, 4, 8, 16, 32]) {
    const bpm = (60 * bars * perBar) / duration;
    for (const m of [1, 2, 0.5])
      if (Math.abs(bpm * m - estimate) / estimate < 0.04 && bpm * m >= 60 && bpm * m <= 200)
        return Math.round(bpm * m * 100) / 100;
  }
  // A syncopated pattern (a bass on dotted eighths, a three-over-two hat) repeats every 1.5 beats: the pulse found is 2/3
  // of the tempo. A loop that is whole bars at 1.5 × the estimate is read that way (checked after the plain fits, so a
  // loop that fits at the estimate itself keeps it).
  for (const bars of [1, 2, 4, 8, 16, 32]) {
    const bpm = (60 * bars * perBar) / duration;
    if (Math.abs(bpm - estimate * 1.5) / (estimate * 1.5) < 0.012 && bpm >= 60 && bpm <= 200) return Math.round(bpm * 100) / 100;
  }
  return Math.round(estimate * 10) / 10;
}
