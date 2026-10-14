// The Wavetable synth's factory tables: ten morph series, each written as a Fourier series so every
// mip level is exactly band-limited. Built once on the main thread (~40 ms) and handed to kernels.
import { addPiecewise, addSampled, WavetableBank, type WavetableSpec } from '@agstudio/sdk/dsp/wavetable';

/** Frames (morph steps) per table. */
export const FRAMES = 16;

const SAW = [0, 1, 1, -1];
const SQUARE = [0, 1, 0.5, 1, 0.5, -1, 1, -1];
const TRIANGLE = [0, 0, 0.25, 1, 0.75, -1, 1, 0];

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

// Male vowel formants: frequency (Hz) and level (dB) of the first three formants.
const VOWELS: readonly (readonly [number, number, number, number, number, number])[] = [
  [600, 1040, 2250, 0, -7, -9], // a
  [400, 1620, 2400, 0, -12, -9], // e
  [250, 1750, 2600, 0, -30, -16], // i
  [400, 750, 2400, 0, -11, -21], // o
  [350, 600, 2400, 0, -20, -32], // u
];
/** The pitch the vowels are "sung" at (the table's fundamental). */
const VOICE_HZ = 110;

const ORGAN_PARTIALS = [1, 2, 3, 4, 5, 6, 8] as const;
const REGISTRATIONS = [
  [1, 0, 0, 0, 0, 0, 0],
  [1, 0.7, 0.3, 0.4, 0, 0, 0],
  [1, 0.8, 0.6, 0.7, 0.3, 0.3, 0.2],
  [1, 1, 1, 1, 0.8, 0.8, 0.8],
] as const;

const GLASS_PARTIALS = [1, 3, 6, 10, 15, 21, 28, 36] as const;

/** Repeatable "random" numbers in [0, 1) for the grit table. */
function hash(k: number): number {
  let h = Math.imul(k ^ 0x5bd1e995, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export interface Table {
  id: string;
  label: string;
  /** What the table does as its position moves from 0 to 100%. */
  hint: string;
  spec: WavetableSpec;
}

export const TABLES: readonly Table[] = [
  {
    id: 'basic',
    label: 'Basic shapes',
    hint: 'Sine → triangle → saw → square',
    spec: {
      name: 'Basic shapes',
      frame(p, sin, cos) {
        const [i, t] = segment(p, 3);
        const shapes = [null, TRIANGLE, SAW, SQUARE] as const;
        const add = (shape: (typeof shapes)[number], gain: number) => {
          if (gain === 0) return;
          if (shape) addPiecewise(shape, sin, cos, gain);
          else sin[1] = (sin[1] as number) + gain;
        };
        add(shapes[i] ?? null, 1 - t);
        add(shapes[i + 1] ?? null, t);
      },
    },
  },
  {
    id: 'pulse',
    label: 'Pulse width',
    hint: 'Square (50%) → thin, nasal pulse (3%)',
    spec: {
      name: 'Pulse width',
      frame(p, sin, cos) {
        const w = 0.5 - 0.47 * p;
        addPiecewise([0, 1, w, 1, w, -1, 1, -1], sin, cos);
      },
    },
  },
  {
    id: 'sync',
    label: 'Sync sweep',
    hint: 'A hard-synced saw: its second oscillator sweeps from 1× to 8× (the classic sync scream)',
    spec: {
      name: 'Sync sweep',
      frame(p, sin, cos) {
        const r = 1 + 7 * p;
        const points = [0, 1];
        for (let j = 1; j < r; j++) points.push(j / r, -1, j / r, 1);
        const rest = r - Math.floor(r);
        points.push(1, rest > 0 ? 1 - 2 * rest : -1);
        addPiecewise(points, sin, cos);
      },
    },
  },
  {
    id: 'harmonics',
    label: 'Harmonic series',
    hint: 'Adds harmonics one by one: from a pure sine to 24 harmonics',
    spec: {
      name: 'Harmonic series',
      frame(p, sin) {
        const n = 1 + 23 * p;
        const whole = Math.floor(n);
        for (let k = 1; k <= whole + 1 && k < sin.length; k++) {
          const share = k <= whole ? 1 : n - whole;
          sin[k] = (sin[k] as number) + share / Math.pow(k, 0.8);
        }
      },
    },
  },
  {
    id: 'vocal',
    label: 'Vocal',
    hint: 'Sung vowels: a → e → i → o → u',
    spec: {
      name: 'Vocal',
      frame(p, sin, cos) {
        const [i, t] = segment(p, VOWELS.length - 1);
        const a = VOWELS[i]!;
        const b = VOWELS[i + 1] ?? a;
        const f = [0, 1, 2].map((j) => a[j]! + (b[j]! - a[j]!) * t);
        const g = [3, 4, 5].map((j) => Math.pow(10, (a[j]! + (b[j]! - a[j]!) * t) / 20));
        const width = [110, 140, 200];
        for (let k = 1; k < sin.length; k++) {
          const hz = k * VOICE_HZ;
          if (hz > 5000) break;
          let env = 0.02;
          for (let j = 0; j < 3; j++) env += g[j]! / (1 + ((hz - f[j]!) / width[j]!) ** 2);
          addPartial(k, env / Math.sqrt(k), sin, cos);
        }
      },
    },
  },
  {
    id: 'formant',
    label: 'Formant sweep',
    hint: 'One resonant peak sweeping up the harmonics, like a wah pedal',
    spec: {
      name: 'Formant sweep',
      frame(p, sin, cos) {
        const centre = 2 + 46 * p;
        const width = 1.5 + 0.12 * centre;
        for (let k = 1; k <= 96 && k < sin.length; k++)
          addPartial(k, (0.12 + 1 / (1 + ((k - centre) / width) ** 2)) / Math.sqrt(k), sin, cos);
      },
    },
  },
  {
    id: 'organ',
    label: 'Organ',
    hint: 'Drawbar registrations: a soft flute → full organ',
    spec: {
      name: 'Organ',
      frame(p, sin) {
        const [i, t] = segment(p, REGISTRATIONS.length - 1);
        const a = REGISTRATIONS[i]!;
        const b = REGISTRATIONS[i + 1] ?? a;
        ORGAN_PARTIALS.forEach((k, j) => (sin[k] = (sin[k] as number) + a[j]! + (b[j]! - a[j]!) * t));
      },
    },
  },
  {
    id: 'glass',
    label: 'Glass',
    hint: 'Sparse high partials: a sine → bright, glassy bells',
    spec: {
      name: 'Glass',
      frame(p, sin, cos) {
        GLASS_PARTIALS.forEach((k, j) =>
          addPartial(k, j === 0 ? 1 : (Math.pow(p, 1.5) * 0.9) / Math.sqrt(j), sin, cos),
        );
      },
    },
  },
  {
    id: 'resonant',
    label: 'Resonant sweep',
    hint: 'A Casio CZ-style resonance: a fading inner wave whose pitch rises from 1× to 16×',
    spec: {
      name: 'Resonant sweep',
      frame(p, sin, cos) {
        const m = 1 + 15 * p;
        addSampled((t) => (1 - t) * Math.sin(2 * Math.PI * m * t), sin, cos);
      },
    },
  },
  {
    id: 'grit',
    label: 'Digital grit',
    hint: 'A saw-like tone → harmonics at random levels (gritty, digital)',
    spec: {
      name: 'Digital grit',
      frame(p, sin, cos) {
        for (let k = 1; k <= 128 && k < sin.length; k++) {
          const random = hash(k) * 2;
          addPartial(k, (1 - p + p * random * random) / Math.pow(k, 0.75), sin, cos);
        }
      },
    },
  },
];

export const TABLE_IDS = TABLES.map((t) => t.id) as readonly string[];

let bank: WavetableBank | null = null;

/** The factory bank, built on first use (shared memory when the page is cross-origin isolated). */
export function factoryBank(): WavetableBank {
  bank ??= WavetableBank.build(
    TABLES.map((t) => t.spec),
    FRAMES,
    true,
  );
  return bank;
}
