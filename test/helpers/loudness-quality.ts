/**
 * Objective measures of how clean a loud master is, and the master loudness stages (the Limiter alone, the Maximizer in front of it,
 * and a hard clipper as the negative control) run on a recorded mix. Pure and deterministic: the unit tests run them on synthetic
 * mixes and the browser tests on the engine's own renders of the EDM styles. Architecture.md ("Loudness stage") explains each limit.
 */
import { Measurer, type Measurement } from '@app/analysis/measure';
import { LinkwitzRiley, Oversampler, TruePeak } from '@agstudio/sdk/worklet';
import { paramBlock, testHost, testTransport } from '@agstudio/sdk/testing';
import { LimiterKernel } from '../../src/plugins/builtin/limiter/kernel';
import { limiterParams } from '../../src/plugins/builtin/limiter/params';
import { MaximizerKernel } from '../../src/plugins/builtin/maximizer/kernel';
import { SaturatorKernel } from '../../src/plugins/builtin/saturator/kernel';
import { saturatorParams } from '../../src/plugins/builtin/saturator/params';
import { maximizerParams } from '../../src/plugins/builtin/maximizer/params';

export const SR = 48000;
export type Stereo = [Float32Array, Float32Array];

export const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
export const gain = (d: number) => Math.pow(10, d / 20);

export function measure(x: Stereo): Measurement {
  const m = new Measurer(SR, true);
  m.push(x[0], x[1]);
  return m.result();
}

// ------------------------------------------------------------------ the stages

/** Runs a kernel over a whole recording in 128-frame blocks; its look-ahead delay is cut off so the result lines up with the input. */
function runKernel(
  kernel: { process(i: Float32Array[], o: Float32Array[], n: number, p: never): void },
  params: unknown,
  latency: number,
  x: Stereo,
): Stereo {
  const n = x[0].length;
  const L = new Float32Array(n + latency);
  const R = new Float32Array(n + latency);
  const inL = new Float32Array(n + latency);
  const inR = new Float32Array(n + latency);
  inL.set(x[0]);
  inR.set(x[1]);
  const B = 128;
  for (let b = 0; b < n + latency; b += B) {
    const m = Math.min(B, n + latency - b);
    kernel.process([inL.subarray(b, b + m), inR.subarray(b, b + m)], [L.subarray(b, b + m), R.subarray(b, b + m)], m, params as never);
  }
  return [L.subarray(latency, latency + n).slice(), R.subarray(latency, latency + n).slice()];
}

export interface LimiterSettings {
  input?: number;
  ceiling?: number;
  release?: number;
  truePeak?: boolean;
}

/** The master Limiter plugin's kernel. */
export function limiterStage(x: Stereo, p: LimiterSettings = {}): Stereo {
  const k = new LimiterKernel(testHost({ sampleRate: SR }));
  k.transport = testTransport({ playing: false, sampleRate: SR });
  return runKernel(k as never, paramBlock(limiterParams, { ...p }), k.latency, x);
}

export interface MaximizerSettings {
  input?: number;
  ceiling?: number;
  clip?: number;
  knee?: number;
  release?: number;
}

/** The Maximizer plugin's kernel. */
export function maximizerStage(x: Stereo, p: MaximizerSettings = {}): Stereo {
  const k = new MaximizerKernel(testHost({ sampleRate: SR }));
  k.transport = testTransport({ playing: false, sampleRate: SR });
  return runKernel(k as never, paramBlock(maximizerParams, { ...p }), k.latency, x);
}

/** What the master does today: the Limiter alone, `input` dB into it. */
export const limiterOnly = (x: Stereo, input: number): Stereo => limiterStage(x, { input });

/** The loudness stage: the Maximizer (`input` dB, a soft clip of `clip` dB), then the Limiter at 0 dB. */
export const maximized = (x: Stereo, input: number, clip = 2, knee = 3): Stereo =>
  limiterStage(maximizerStage(x, { input, clip, knee }), { input: 0 });

/**
 * The negative control, the master hard clipper that made a song sound like static: the Saturator in hard-clip mode driven `drive` dB
 * (2× oversampled, fully wet, its output raised by the 0.7 dB per dB of drive it gives back) in front of the Limiter. The Studio now turns such a clipper into gentle tape (`tameMasterClipper`).
 */
export function hardClipped(x: Stereo, drive: number): Stereo {
  const k = new SaturatorKernel(testHost({ sampleRate: SR }));
  k.transport = testTransport({ playing: false, sampleRate: SR });
  const clipped = runKernel(k as never, paramBlock(saturatorParams, { mode: 'clip', drive, mix: 1, output: Math.min(12, 0.7 * drive), oversample: '2x' }), 0, x);
  return limiterStage(clipped, { input: 0 });
}

/** Bisection on a stage's input gain (dB) until the chain reaches `target` LUFS (the closest reading it saw). */
export function reachLoudness(x: Stereo, target: number, chain: (x: Stereo, input: number) => Stereo, max = 24, tolerance = 0.03) {
  let lo = 0;
  let hi = max;
  let best = { input: 0, y: chain(x, 0), lufs: -Infinity };
  best.lufs = measure(best.y).lufs;
  for (let it = 0; it < 12 && Math.abs(best.lufs - target) > tolerance; it++) {
    const mid = (lo + hi) / 2;
    const y = chain(x, mid);
    const lufs = measure(y).lufs;
    if (lufs < target) lo = mid;
    else hi = mid;
    if (Math.abs(lufs - target) < Math.abs(best.lufs - target)) best = { input: mid, y, lufs };
  }
  return best;
}

// ------------------------------------------------------------------ the measures

/** True peak (dBTP) of a stereo signal, with the SDK's detector. */
export function truePeakDb(x: Stereo): number {
  let peak = 0;
  for (const ch of x) {
    const tp = new TruePeak();
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, tp.process(ch[i]!));
  }
  return db(peak);
}

/**
 * Hard clipping at sample level: how many runs of 4 or more consecutive samples are equal to the loudest sample (within 0.00009 dB), a flat
 * top. A limiter's ramps and a soft clip's curve leave a sample or two at a crest (a sine at the peak has about one); a hard clipper leaves
 * runs of them. (Within 0.04 dB would count every crest of a bass sine as flat.)
 */
export function flatTopRuns(y: Stereo): number {
  let peak = 0;
  for (const ch of y) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  const limit = peak * (1 - 1e-5);
  let runs = 0;
  for (const ch of y) {
    let run = 0;
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]!) >= limit) run++;
      else {
        if (run >= 4) runs++;
        run = 0;
      }
    }
  }
  return runs;
}

/**
 * The recording through the Maximizer's 2× oversampler and back with nothing in between: its halfband filters shift the phase of the
 * highs a little (linear, not distortion), so that is what `distortion` compares a Maximizer chain's output with.
 */
export function viaOversampler(x: Stereo): Stereo {
  return x.map((ch) => {
    const os = new Oversampler(2);
    return ch.map((v) => (os.up(v), os.down()));
  }) as Stereo;
}

const WINDOW = 1024;

/**
 * The distortion measure: how much of the output is not a scaled copy of the input. In every 1024-frame window (21 ms) the best gain `g`
 * (least squares) from the reference to the output is taken out, and what is left, |y − g·x|², is the distortion plus the gain's own
 * fast wobble. Returns that energy as dB under the output's, over the whole signal (`total`) and for the 95th-percentile window (`p95`:
 * the worst moments, the hits). Slow level changes (a limiter's release, a fade) are not counted; harmonics, intermodulation and
 * pumping faster than 20 ms are. Lower (more negative) is cleaner.
 */
export function distortion(ref: Stereo, y: Stereo): { total: number; p95: number } {
  let num = 0;
  let den = 0;
  const per: number[] = [];
  for (let s = 0; s + WINDOW <= ref[0].length; s += WINDOW) {
    let rr = 0;
    let ry = 0;
    let yy = 0;
    for (let c = 0; c < 2; c++)
      for (let i = s; i < s + WINDOW; i++) {
        const r = ref[c]![i]!;
        const v = y[c]![i]!;
        rr += r * r;
        ry += r * v;
        yy += v * v;
      }
    if (yy < 1e-8 || rr < 1e-8) continue;
    const e = Math.max(0, yy - (ry / rr) * ry);
    num += e;
    den += yy;
    per.push(10 * Math.log10(Math.max(1e-12, e) / yy));
  }
  per.sort((a, b) => a - b);
  return { total: 10 * Math.log10(num / den), p95: per[Math.floor(per.length * 0.95)] ?? -Infinity };
}

/** One channel pair through a Linkwitz–Riley high-pass (to look at what the distortion does in the highs). */
export function highpassed(x: Stereo, freq: number): Stereo {
  return x.map((ch) => {
    const lr = new LinkwitzRiley().set(freq, SR);
    return ch.map((v) => (lr.split(v), lr.high));
  }) as Stereo;
}

/** Where the kicks are: peaks of the sub band (under 150 Hz) of the mix, within 4 dB of its strongest, 0.2 s apart; 6 ms before the peak. */
export function kickOnsets(x: Stereo): number[] {
  const lr = new LinkwitzRiley().set(150, SR);
  const env = new Float32Array(x[0].length);
  let e = 0;
  for (let i = 0; i < env.length; i++) {
    lr.split(0.5 * (x[0][i]! + x[1][i]!));
    const a = Math.abs(lr.low);
    e = a > e ? a : e * 0.9995;
    env[i] = e;
  }
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  const out: number[] = [];
  let last = -1e9;
  for (let i = 1; i < env.length - 1; i++)
    if (env[i]! > 0.6 * max && env[i]! >= env[i - 1]! && env[i]! > env[i + 1]! && i - last > 0.2 * SR) {
      out.push(Math.max(0, i - Math.round(0.006 * SR)));
      last = i;
    }
  return out;
}

/**
 * Kick punch: the loudest sample in the 25 ms after a kick starts, over the RMS of the 400 ms from its start, in dB (the mean over the
 * kicks). A kick that keeps its click and weight scores high; one that has been squashed down into the rest of the mix scores low.
 */
export function kickPunch(y: Stereo, onsets: readonly number[]): number {
  const vals: number[] = [];
  const n = Math.round(0.4 * SR);
  for (const o of onsets) {
    if (o + n >= y[0].length) continue;
    let peak = 0;
    for (let c = 0; c < 2; c++) for (let i = o; i < o + 0.025 * SR; i++) peak = Math.max(peak, Math.abs(y[c]![i]!));
    let sum = 0;
    for (let c = 0; c < 2; c++) for (let i = o; i < o + n; i++) sum += y[c]![i]! ** 2;
    vals.push(db(peak) - 10 * Math.log10(sum / (2 * n)));
  }
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
}

/**
 * Kick weight: the level of the sub band (under 150 Hz) in the 10–120 ms after a kick starts, in dB under the whole mix's loudness (LUFS).
 * A limiter that turns the mix down for every kick takes the weight out of the kick's body; this keeps track of it.
 */
export function kickWeight(y: Stereo, onsets: readonly number[]): number {
  const lr = [new LinkwitzRiley().set(150, SR), new LinkwitzRiley().set(150, SR)];
  const low = y.map((ch, c) => ch.map((v) => (lr[c]!.split(v), lr[c]!.low))) as Stereo;
  const from = Math.round(0.01 * SR);
  const n = Math.round(0.11 * SR);
  const vals: number[] = [];
  for (const o of onsets) {
    if (o + from + n >= y[0].length) continue;
    let sum = 0;
    for (let c = 0; c < 2; c++) for (let i = o + from; i < o + from + n; i++) sum += low[c]![i]! ** 2;
    vals.push(10 * Math.log10(sum / (2 * n)));
  }
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length) - measure(y).lufs;
}

export interface Quality {
  lufs: number;
  truePeakDb: number;
  flatTops: number;
  /** Distortion (dB under the output): the whole signal, its worst 5 % of windows, and the part above 3 kHz. */
  distortion: number;
  distortionP95: number;
  distortionHigh: number;
  punch: number;
  weight: number;
}

/** Everything above for an output against the recording it was made from. */
export function quality(y: Stereo, ref: Stereo, onsets: readonly number[]): Quality {
  const m = measure(y);
  const d = distortion(ref, y);
  return {
    lufs: m.lufs,
    truePeakDb: m.truePeakDb ?? NaN,
    flatTops: flatTopRuns(y),
    distortion: d.total,
    distortionP95: d.p95,
    distortionHigh: distortion(highpassed(ref, 3000), highpassed(y, 3000)).total,
    punch: kickPunch(y, onsets),
    weight: kickWeight(y, onsets),
  };
}

export const describeQuality = (q: Quality) =>
  `${q.lufs.toFixed(2)} LUFS, ${q.truePeakDb.toFixed(2)} dBTP, flat tops ${q.flatTops}, distortion ${q.distortion.toFixed(1)} dB (worst ${q.distortionP95.toFixed(1)}, highs ${q.distortionHigh.toFixed(1)}), kick punch ${q.punch.toFixed(1)} dB, weight ${q.weight.toFixed(1)} dB`;
