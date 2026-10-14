// The Slicer's built-in demo loop: a two-bar drum break at 120 BPM, synthesized from the SDK's
// drum models, so an empty Slicer already plays something to slice. Pure DSP (no React).
import { Clap, HiHat, Kick, Perc, renderDrum, Snare, type DrumModel } from '@agstudio/sdk/dsp/drums';

/** The demo is always rendered at this rate (the kernel resamples), so the editor and kernel slice the same audio. */
export const DEMO_RATE = 48000;
export const DEMO_BPM = 120;
const STEPS = 32;
const STEP_SECONDS = 60 / DEMO_BPM / 4;
/** Seconds: two bars at 120 BPM. */
export const DEMO_SECONDS = STEPS * STEP_SECONDS;

type Hit = [step: number, velocity: number];

/** The break, on a 16th-note grid over two bars. */
const PATTERN: { make: (sr: number) => DrumModel; hits: Hit[] }[] = [
  {
    make: (sr) =>
      Object.assign(new Kick(sr, 3), { pitch: 52, sweep: 24, sweepTime: 0.035, decay: 0.35, click: 0.4, drive: 0.3 }),
    hits: [
      [0, 1],
      [6, 0.8],
      [10, 0.9],
      [16, 1],
      [19, 0.7],
      [22, 0.85],
      [26, 0.9],
    ],
  },
  {
    make: (sr) => Object.assign(new Snare(sr, 4), { tone: 200, snappy: 0.65, decay: 0.18, brightness: 2800 }),
    hits: [
      [4, 0.9],
      [12, 0.9],
      [15, 0.3],
      [20, 0.9],
      [28, 0.95],
      [31, 0.35],
    ],
  },
  {
    make: (sr) => Object.assign(new HiHat(sr, 5), { decay: 0.045, tone: 0.7 }),
    hits: [0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 28].map((s) => [s, s % 4 === 0 ? 0.55 : 0.35] as Hit),
  },
  {
    make: (sr) => Object.assign(new HiHat(sr, 6), { decay: 0.35, tone: 0.65, noiseMix: 0.32 }),
    hits: [
      [14, 0.45],
      [30, 0.45],
    ],
  },
  {
    make: (sr) => Object.assign(new Perc(sr, 7), { pitch: 1700, ring: 1, decay: 0.035, noiseMix: 0.6 }),
    hits: [
      [7, 0.5],
      [23, 0.5],
    ],
  },
  {
    make: (sr) => Object.assign(new Clap(sr, 8), { tone: 1300, decay: 0.2, spread: 0.01 }),
    hits: [[28, 0.5]],
  },
];

let cached: Float32Array | null = null;

/** The demo loop (mono, DEMO_RATE), rendered once (about 10 ms) and shared. */
export function demoLoop(): Float32Array {
  if (cached) return cached;
  const length = Math.round(DEMO_SECONDS * DEMO_RATE);
  const out = new Float32Array(length);
  for (const part of PATTERN) {
    for (const [step, velocity] of part.hits) {
      const hit = renderDrum(part.make(DEMO_RATE), velocity, 2);
      const at = Math.round(step * STEP_SECONDS * DEMO_RATE);
      for (let i = 0; i < hit.length && at + i < length; i++)
        out[at + i] = (out[at + i] as number) + (hit[i] as number);
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i] as number));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] = ((out[i] as number) * 0.9) / peak;
  cached = out;
  return out;
}
