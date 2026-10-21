/**
 * The factory racks: five starting points for sound design, each a rack of the built-in effects with its macros already
 * mapped. A recipe is data (plugin ids, preset names, settings and which macro moves what, by position in the rack);
 * `build.ts` makes the real rack from it.
 */
import type { MacroCurve, RackSplit } from '@core/model/types';
import { COMPRESSOR, DELAY, EQ_PRO, REVERB, SATURATOR, eqBands, type FxRecipe } from '../mix/recipe-parts';

const CHORUS = 'agstudio.chorus';
const LOFI = 'agstudio.lofi';

/** One effect in a branch: the recipe of a mix-setup effect, with its dry/wet and bypass. */
export interface RackRecipeFx extends FxRecipe {
  mix?: number;
  enabled?: boolean;
}

/** One branch of a factory rack. */
export interface RackRecipeBranch {
  name: string;
  levelDb?: number;
  pan?: number;
  fx: RackRecipeFx[];
}

/** What a macro of a factory rack moves, by place in the rack (branch and effect numbers count from 0). */
export type RecipeTarget =
  | { fx: readonly [branch: number, index: number]; param: string }
  | { mix: readonly [branch: number, index: number] }
  | { branch: number; param: 'level' | 'pan' }
  | { crossover: number }
  | { gain: true };

/** One mapping of a factory macro. */
export interface RecipeMapping {
  to: RecipeTarget;
  min: number;
  max: number;
  curve?: MacroCurve;
}

/** One macro of a factory rack. */
export interface RecipeMacro {
  name: string;
  /** Where the knob starts (0–1). */
  value: number;
  maps: RecipeMapping[];
}

/** A factory rack as data. */
export interface FactoryRack {
  name: string;
  /** What it is for, in a sentence. */
  description: string;
  split: RackSplit;
  crossovers?: number[];
  branches: RackRecipeBranch[];
  macros: RecipeMacro[];
  /** The rack's output gain in dB (default 0). */
  gainDb?: number;
}

const parallelNewYork: FactoryRack = {
  name: 'Parallel NY compression',
  description:
    'New York compression: the sound stays as it is while a heavily squashed, brightened copy is blended in underneath for weight and density. Turn Blend for how much, Squash for how hard.',
  split: 'parallel',
  branches: [
    { name: 'Dry', fx: [] },
    {
      name: 'Squashed',
      levelDb: -13,
      fx: [
        {
          pluginId: EQ_PRO,
          label: 'smile EQ',
          params: eqBands({ 2: { type: 'lowShelf', freq: 90, gain: 4 }, 7: { type: 'highShelf', freq: 9000, gain: 3 } }),
        },
        { pluginId: COMPRESSOR, preset: 'Heavy squash', label: 'heavy compressor' },
      ],
    },
  ],
  macros: [
    { name: 'Blend', value: 0.7, maps: [{ to: { branch: 1, param: 'level' }, min: -40, max: -2 }] },
    {
      name: 'Squash',
      value: 0.6,
      maps: [
        { to: { fx: [1, 1], param: 'threshold' }, min: -20, max: -45 },
        { to: { fx: [1, 1], param: 'ratio' }, min: 4, max: 20 },
      ],
    },
    { name: 'Snap', value: 0.5, maps: [{ to: { fx: [1, 1], param: 'attack' }, min: 30, max: 0.5 }] },
    { name: 'Sparkle', value: 0.35, maps: [{ to: { fx: [1, 0], param: 'b7Gain' }, min: 0, max: 9 }] },
    { name: 'Output', value: 2 / 3, maps: [{ to: { gain: true }, min: -6, max: 3 }] },
  ],
};

const multibandSaturation: FactoryRack = {
  name: 'Multiband saturation',
  description:
    'Splits the sound into lows, mids and highs and warms each with its own saturator: tape on the lows, tube on the mids, a touch on the highs. Each Drive macro heats one band; the Split macros move the crossovers.',
  split: 'bands',
  crossovers: [200, 2500],
  branches: [
    { name: 'Low', fx: [{ pluginId: SATURATOR, label: 'tape saturator', params: { mode: 'tape', drive: 6, output: -2 } }] },
    { name: 'Mid', fx: [{ pluginId: SATURATOR, label: 'tube saturator', params: { mode: 'tube', drive: 6, output: -2 } }] },
    { name: 'High', fx: [{ pluginId: SATURATOR, label: 'light saturator', params: { mode: 'tape', drive: 3, tone: 0.2, output: -1 } }] },
  ],
  macros: [
    { name: 'Low drive', value: 0.25, maps: [{ to: { fx: [0, 0], param: 'drive' }, min: 0, max: 24 }] },
    { name: 'Mid drive', value: 0.25, maps: [{ to: { fx: [1, 0], param: 'drive' }, min: 0, max: 24 }] },
    { name: 'High drive', value: 0.12, maps: [{ to: { fx: [2, 0], param: 'drive' }, min: 0, max: 24 }] },
    { name: 'Low split', value: 0.5, maps: [{ to: { crossover: 0 }, min: 80, max: 500 }] },
    { name: 'High split', value: 0.5, maps: [{ to: { crossover: 1 }, min: 1500, max: 6000 }] },
    { name: 'Output', value: 2 / 3, maps: [{ to: { gain: true }, min: -6, max: 3 }] },
  ],
};

const midSideWidener: FactoryRack = {
  name: 'Mid/side widener',
  description:
    'Keeps the middle of the sound as it is and works on the sides only: the sides are high-passed (so the bass stays centred), brightened and given a little chorus. Width is how loud the sides are.',
  split: 'midside',
  branches: [
    { name: 'Mid', fx: [] },
    {
      name: 'Side',
      fx: [
        {
          pluginId: EQ_PRO,
          label: 'side EQ',
          params: eqBands({ 1: { type: 'lowCut24', freq: 150 }, 7: { type: 'highShelf', freq: 8000, gain: 3 } }),
        },
        { pluginId: CHORUS, label: 'chorus', params: { rate: 0.3, depth: 0.4, width: 1, mix: 0.35 } },
      ],
    },
  ],
  macros: [
    { name: 'Width', value: 0.75, maps: [{ to: { branch: 1, param: 'level' }, min: -18, max: 6 }] },
    { name: 'Shimmer', value: 0.45, maps: [{ to: { fx: [1, 1], param: 'mix' }, min: 0, max: 0.8 }] },
    { name: 'Air', value: 0.33, maps: [{ to: { fx: [1, 0], param: 'b7Gain' }, min: 0, max: 9 }] },
    { name: 'Mono below', value: 0.59, maps: [{ to: { fx: [1, 0], param: 'b1Freq' }, min: 20, max: 600 }] },
    { name: 'Centre', value: 2 / 3, maps: [{ to: { branch: 0, param: 'level' }, min: -6, max: 3 }] },
  ],
};

const dubThrows: FactoryRack = {
  name: 'Dub delay throws with macro',
  description:
    'The sound passes untouched while an echo and reverb branch waits underneath, silent until you open it. Automate or MIDI-map the Throw macro to fire echoes on single words and hits; Feedback, Darken and Space shape how they fall away.',
  split: 'parallel',
  branches: [
    { name: 'Dry', fx: [] },
    {
      name: 'Echo throws',
      levelDb: -12,
      fx: [
        {
          pluginId: DELAY,
          label: 'ping-pong delay',
          params: { time: '1/4', feedback: 0.7, pingPong: true, mix: 1, lowCut: 300, highCut: 4500 },
        },
        { pluginId: REVERB, label: 'plate reverb', params: { decay: 2.8, mix: 0.25 } },
      ],
    },
  ],
  macros: [
    { name: 'Throw', value: 0.85, maps: [{ to: { branch: 1, param: 'level' }, min: -60, max: -2, curve: 'exponential' }] },
    { name: 'Feedback', value: 0.6, maps: [{ to: { fx: [1, 0], param: 'feedback' }, min: 0.3, max: 0.9 }] },
    { name: 'Darken', value: 0.35, maps: [{ to: { fx: [1, 0], param: 'highCut' }, min: 12000, max: 1500 }] },
    { name: 'Space', value: 0.35, maps: [{ to: { fx: [1, 1], param: 'mix' }, min: 0, max: 0.7 }] },
  ],
};

const lofiTape: FactoryRack = {
  name: 'Lo-fi tape with macro',
  description:
    'A worn tape machine in one rack: wobbling pitch, a little bit-crushing, tape saturation and a band-limiting EQ. Wear ages it all at once, Dust adds hiss and crackle, Tone darkens it.',
  split: 'parallel',
  branches: [
    {
      name: 'Tape',
      fx: [
        { pluginId: LOFI, label: 'lo-fi', params: { bits: 12, rate: 32000, wow: 0.15, flutter: 0.1, crackle: 0.05, noise: 0.05, tone: 9000, mix: 1 } },
        { pluginId: SATURATOR, label: 'tape saturator', params: { mode: 'tape', drive: 6, tone: -0.2, output: -3 } },
        {
          pluginId: EQ_PRO,
          label: 'band limit',
          params: eqBands({ 1: { type: 'lowCut24', freq: 40 }, 8: { type: 'highCut24', freq: 15000 } }),
        },
      ],
    },
  ],
  macros: [
    {
      name: 'Wear',
      value: 0.3,
      maps: [
        { to: { fx: [0, 0], param: 'wow' }, min: 0, max: 0.8 },
        { to: { fx: [0, 0], param: 'flutter' }, min: 0, max: 0.5 },
        { to: { fx: [0, 0], param: 'bits' }, min: 16, max: 8 },
        { to: { fx: [0, 1], param: 'drive' }, min: 3, max: 18 },
      ],
    },
    {
      name: 'Dust',
      value: 0.25,
      maps: [
        { to: { fx: [0, 0], param: 'noise' }, min: 0, max: 0.4 },
        { to: { fx: [0, 0], param: 'crackle' }, min: 0, max: 0.6 },
      ],
    },
    { name: 'Tone', value: 0.45, maps: [{ to: { fx: [0, 0], param: 'tone' }, min: 16000, max: 1500 }] },
    { name: 'Output', value: 2 / 3, maps: [{ to: { gain: true }, min: -6, max: 3 }] },
  ],
};

/** The factory racks, in the order the browser lists them. */
export const FACTORY_RACKS: readonly FactoryRack[] = [parallelNewYork, multibandSaturation, midSideWidener, dubThrows, lofiTape];
