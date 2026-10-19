// How each factory table's shape is written at one morph position: one function per table, each a Fourier series, so
// every mip level of the table is exactly band-limited. tables.ts lists them with their names and hints.
import { addPiecewise, addSampled, type WavetableSpec } from '@agstudio/sdk/dsp/wavetable';

/** Writes one table's shape at a morph position (0-1) into the harmonics' sine and cosine amplitudes. */
export type FrameWriter = WavetableSpec['frame'];

const SAW = [0, 1, 1, -1];
const SQUARE = [0, 1, 0.5, 1, 0.5, -1, 1, -1];
const TRIANGLE = [0, 0, 0.25, 1, 0.75, -1, 1, 0];

/** Adds `amount` to a harmonic's sine amplitude (the harmonics' arrays are typed as possibly undefined). */
function addSine(sin: Float64Array, harmonic: number, amount: number): void {
  sin[harmonic] = (sin[harmonic] as number) + amount;
}

/** Fixed phases (Schroeder's) for additive tables: a low crest factor, so they stay loud after normalizing. */
function addPartial(k: number, amp: number, sin: Float64Array, cos: Float64Array): void {
  if (k < 1 || k >= sin.length || amp === 0) return;
  const phase = (Math.PI * k * (k - 1)) / 48;
  sin[k] = (sin[k] as number) + amp * Math.cos(phase);
  cos[k] = (cos[k] as number) + amp * Math.sin(phase);
}

/** Splits a position into a segment of `count` steps and the fraction within it. */
function segment(position: number, count: number): [number, number] {
  const x = Math.min(Math.max(position, 0), 1) * count;
  const i = Math.min(count - 1, Math.floor(x));
  return [i, x - i];
}

/** Repeatable "random" numbers in [0, 1) for the grit table. */
function hash(k: number): number {
  let h = Math.imul(k ^ 0x5bd1e995, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

// Basic shapes: sine → triangle → saw → square (null stands for the sine).
const BASIC_SHAPES = [null, TRIANGLE, SAW, SQUARE] as const;

export const basicShapes: FrameWriter = (position, sin, cos) => {
  const [i, t] = segment(position, 3);
  const add = (shape: (typeof BASIC_SHAPES)[number], gain: number) => {
    if (gain === 0) return;
    if (shape) addPiecewise(shape, sin, cos, gain);
    else addSine(sin, 1, gain);
  };
  add(BASIC_SHAPES[i] ?? null, 1 - t);
  add(BASIC_SHAPES[i + 1] ?? null, t);
};

/** Pulse width: a square at 50 % narrowing to 3 %. */
export const pulseWidth: FrameWriter = (position, sin, cos) => {
  const width = 0.5 - 0.47 * position;
  addPiecewise([0, 1, width, 1, width, -1, 1, -1], sin, cos);
};

/** Sync sweep: a saw whose hard-synced second oscillator sweeps from 1x to 8x. */
export const syncSweep: FrameWriter = (position, sin, cos) => {
  const ratio = 1 + 7 * position;
  const points = [0, 1];
  for (let j = 1; j < ratio; j++) points.push(j / ratio, -1, j / ratio, 1);
  const rest = ratio - Math.floor(ratio);
  points.push(1, rest > 0 ? 1 - 2 * rest : -1);
  addPiecewise(points, sin, cos);
};

/** Harmonic series: harmonics fade in one by one, from a sine to 24 harmonics. */
export const harmonicSeries: FrameWriter = (position, sin) => {
  const count = 1 + 23 * position;
  const whole = Math.floor(count);
  for (let k = 1; k <= whole + 1 && k < sin.length; k++) {
    const share = k <= whole ? 1 : count - whole;
    addSine(sin, k, share / Math.pow(k, 0.8));
  }
};

// Male vowel formants: frequency (Hz) of the first three formants, then their level (dB).
const VOWELS: readonly (readonly [number, number, number, number, number, number])[] = [
  [600, 1040, 2250, 0, -7, -9], // a
  [400, 1620, 2400, 0, -12, -9], // e
  [250, 1750, 2600, 0, -30, -16], // i
  [400, 750, 2400, 0, -11, -21], // o
  [350, 600, 2400, 0, -20, -32], // u
];
/** The pitch the vowels are "sung" at (the table's fundamental), Hz. */
const VOICE_HZ = 110;
/** Bandwidth of each of the three formants, Hz. */
const FORMANT_WIDTHS_HZ = [110, 140, 200];
/** Above this the vowels have no more energy worth adding, Hz. */
const VOWEL_TOP_HZ = 5000;

/** Vocal: sung vowels a → e → i → o → u, each a sum of three formant peaks over the harmonics. */
export const vocal: FrameWriter = (position, sin, cos) => {
  const [i, t] = segment(position, VOWELS.length - 1);
  const from = VOWELS[i]!;
  const to = VOWELS[i + 1] ?? from;
  const frequency = [0, 1, 2].map((j) => from[j]! + (to[j]! - from[j]!) * t);
  const gain = [3, 4, 5].map((j) => Math.pow(10, (from[j]! + (to[j]! - from[j]!) * t) / 20));
  for (let k = 1; k < sin.length; k++) {
    const hz = k * VOICE_HZ;
    if (hz > VOWEL_TOP_HZ) break;
    let envelope = 0.02;
    for (let j = 0; j < 3; j++) envelope += gain[j]! / (1 + ((hz - frequency[j]!) / FORMANT_WIDTHS_HZ[j]!) ** 2);
    addPartial(k, envelope / Math.sqrt(k), sin, cos);
  }
};

/** Formant sweep: one resonant peak sweeping up the harmonics, like a wah pedal. */
export const formantSweep: FrameWriter = (position, sin, cos) => {
  const centre = 2 + 46 * position;
  const width = 1.5 + 0.12 * centre;
  for (let k = 1; k <= 96 && k < sin.length; k++)
    addPartial(k, (0.12 + 1 / (1 + ((k - centre) / width) ** 2)) / Math.sqrt(k), sin, cos);
};

const ORGAN_PARTIALS = [1, 2, 3, 4, 5, 6, 8] as const;
/** Drawbar settings, from a soft flute to a full organ. */
const REGISTRATIONS = [
  [1, 0, 0, 0, 0, 0, 0],
  [1, 0.7, 0.3, 0.4, 0, 0, 0],
  [1, 0.8, 0.6, 0.7, 0.3, 0.3, 0.2],
  [1, 1, 1, 1, 0.8, 0.8, 0.8],
] as const;

/** Organ: drawbar registrations, blended between neighbours. */
export const organ: FrameWriter = (position, sin) => {
  const [i, t] = segment(position, REGISTRATIONS.length - 1);
  const from = REGISTRATIONS[i]!;
  const to = REGISTRATIONS[i + 1] ?? from;
  ORGAN_PARTIALS.forEach((k, j) => addSine(sin, k, from[j]! + (to[j]! - from[j]!) * t));
};

const GLASS_PARTIALS = [1, 3, 6, 10, 15, 21, 28, 36] as const;

/** Glass: a sine with sparse high partials fading in (bright, glassy bells). */
export const glass: FrameWriter = (position, sin, cos) => {
  GLASS_PARTIALS.forEach((k, j) =>
    addPartial(k, j === 0 ? 1 : (Math.pow(position, 1.5) * 0.9) / Math.sqrt(j), sin, cos),
  );
};

/** Resonant sweep: a Casio CZ-style fading inner wave whose pitch rises from 1x to 16x. */
export const resonantSweep: FrameWriter = (position, sin, cos) => {
  const multiple = 1 + 15 * position;
  addSampled((t) => (1 - t) * Math.sin(2 * Math.PI * multiple * t), sin, cos);
};

/** Digital grit: a saw-like tone turning into harmonics at random (but repeatable) levels. */
export const digitalGrit: FrameWriter = (position, sin, cos) => {
  for (let k = 1; k <= 128 && k < sin.length; k++) {
    const random = hash(k) * 2;
    addPartial(k, (1 - position + position * random * random) / Math.pow(k, 0.75), sin, cos);
  }
};
