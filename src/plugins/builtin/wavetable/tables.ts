// The Wavetable synth's factory tables: ten morph series, each written as a Fourier series (table-frames.ts) so every
// mip level is exactly band-limited. Built once on the main thread (~40 ms) and handed to kernels.
import { WavetableBank, type WavetableSpec } from '@agstudio/sdk/dsp/wavetable';
import {
  basicShapes,
  digitalGrit,
  formantSweep,
  glass,
  harmonicSeries,
  organ,
  pulseWidth,
  resonantSweep,
  syncSweep,
  vocal,
} from './table-frames';

/** Frames (morph steps) per table. */
export const FRAMES = 16;

export interface Table {
  id: string;
  label: string;
  /** What the table does as its position moves from 0 to 100%. */
  hint: string;
  spec: WavetableSpec;
}

/** The factory tables, in the order the Table menus list them (the ids are stored in projects). */
export const TABLES: readonly Table[] = [
  {
    id: 'basic',
    label: 'Basic shapes',
    hint: 'Sine → triangle → saw → square',
    spec: { name: 'Basic shapes', frame: basicShapes },
  },
  {
    id: 'pulse',
    label: 'Pulse width',
    hint: 'Square (50%) → thin, nasal pulse (3%)',
    spec: { name: 'Pulse width', frame: pulseWidth },
  },
  {
    id: 'sync',
    label: 'Sync sweep',
    hint: 'A hard-synced saw: its second oscillator sweeps from 1× to 8× (the classic sync scream)',
    spec: { name: 'Sync sweep', frame: syncSweep },
  },
  {
    id: 'harmonics',
    label: 'Harmonic series',
    hint: 'Adds harmonics one by one: from a pure sine to 24 harmonics',
    spec: { name: 'Harmonic series', frame: harmonicSeries },
  },
  {
    id: 'vocal',
    label: 'Vocal',
    hint: 'Sung vowels: a → e → i → o → u',
    spec: { name: 'Vocal', frame: vocal },
  },
  {
    id: 'formant',
    label: 'Formant sweep',
    hint: 'One resonant peak sweeping up the harmonics, like a wah pedal',
    spec: { name: 'Formant sweep', frame: formantSweep },
  },
  {
    id: 'organ',
    label: 'Organ',
    hint: 'Drawbar registrations: a soft flute → full organ',
    spec: { name: 'Organ', frame: organ },
  },
  {
    id: 'glass',
    label: 'Glass',
    hint: 'Sparse high partials: a sine → bright, glassy bells',
    spec: { name: 'Glass', frame: glass },
  },
  {
    id: 'resonant',
    label: 'Resonant sweep',
    hint: 'A Casio CZ-style resonance: a fading inner wave whose pitch rises from 1× to 16×',
    spec: { name: 'Resonant sweep', frame: resonantSweep },
  },
  {
    id: 'grit',
    label: 'Digital grit',
    hint: 'A saw-like tone → harmonics at random levels (gritty, digital)',
    spec: { name: 'Digital grit', frame: digitalGrit },
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
