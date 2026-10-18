/**
 * Golden references. A kernel rendered with automated params is compared with values recorded from
 * the same run before the kernel was optimized: chunk RMS (dB) and every 256th sample, and steady
 * output by bit hash.
 */
import { fromNormalized, type FloatSpec, type ParamSpecs } from '../params';
import { rms } from './measure';
import type { TestParams } from './params';

/** Length of a golden run: 2 s at 48 kHz. */
export const GOLDEN_FRAMES = 96000;

const GOLDEN_RATE = 48000;
/** The noise bursts of the golden input: one every 200 ms, decaying over 12 ms. */
const BURST_PERIOD_FRAMES = 9600;
const BURST_DECAY_SEC = 0.012;
/** The benchmark's automation sweeps each param at 0.25 Hz. */
const SWEEP_HZ = 0.25;
/** The sweeps' phases are spread over this many (so three params start a third of a cycle apart). */
const SWEEP_PHASE_SPREAD = 3;
/** Level floor for comparing RMS values in dB: −120 dBFS keeps silence finite. */
const RMS_FLOOR = 1e-6;

/** Music-like test input: a sine pair, plus a noise burst every 200 ms that decays over 12 ms. Deterministic. */
export function goldenInput(frame: number, channel: number): number {
  const t = frame / GOLDEN_RATE;
  const burst =
    Math.exp(-((frame % BURST_PERIOD_FRAMES) / GOLDEN_RATE) / BURST_DECAY_SEC) * 0.6 * noise(frame, channel);
  return 0.25 * Math.sin(2 * Math.PI * 110 * t + channel * 0.3) + 0.15 * Math.sin(2 * Math.PI * 330 * t) + burst;
}

/** Deterministic white noise in [-1, 1) for a frame and channel. */
function noise(frame: number, channel: number): number {
  let x = Math.imul((frame * 2 + channel) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Per-frame automation for the given float params, as the CPU benchmark draws it (`--automate`): a
 * sine across each param's normalized range (so log and dB ranges are swept evenly to the ear) at
 * 0.25 Hz, the phases spread over three sweeps.
 */
export function goldenSweeps<P extends ParamSpecs>(specs: P, keys: readonly (keyof P & string)[]): TestParams<P> {
  const out: Record<string, (frame: number) => number> = {};
  keys.forEach((key, k) => {
    const spec = specs[key] as FloatSpec;
    const phase = k / SWEEP_PHASE_SPREAD;
    out[key] = (frame) =>
      Number(fromNormalized(spec, 0.5 + 0.5 * Math.sin(2 * Math.PI * (SWEEP_HZ * (frame / GOLDEN_RATE) + phase))));
  });
  return out as TestParams<P>;
}

/** RMS of each full chunk of `size` frames of x. */
export function chunkRms(x: Float32Array, size = 1024): number[] {
  const out: number[] = [];
  for (let c = 0; c + size <= x.length; c += size) out.push(rms(x, c, c + size));
  return out;
}

/** Every `stride`-th sample of x. */
export function strided(x: Float32Array, stride = 256): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i += stride) out.push(x[i] as number);
  return out;
}

/** FNV-1a over the IEEE-754 bits of every sample: equal hashes mean bit-identical output. */
export function bitHash(x: Float32Array): string {
  const bits = new Uint32Array(x.buffer, x.byteOffset, x.length);
  let h = 0x811c9dc5;
  for (const word of bits) h = Math.imul(h ^ word, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Largest |a - b| over the samples of a and b (of equal length). */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}

/** Level difference in dB between two RMS values; a floor at -120 dBFS keeps silence finite. */
export function rmsDb(a: number, b: number): number {
  return 20 * Math.log10((a + RMS_FLOOR) / (b + RMS_FLOOR));
}
