/**
 * What an effect rack is made of: the plugin id and parameters of the rack slot, the limits, and the builders of a
 * new rack. Types are in `types/rack.ts`; the edits are in `ops/racks.ts`; the queries in `query/rack.ts`.
 */
import { p, type ParamSpecs } from '@agstudio/sdk/params';
import { newId } from './ids';
import type { BranchId, FxSlot, MacroTarget, PluginInstance, Rack, RackBranch, RackMacro, RackSplit, SlotId } from './types';

/** The id of the built-in effect a rack slot holds. The engine builds the rack itself; this is only its name in the project. */
export const RACK_PLUGIN_ID = 'agstudio.rack';
/** The version of the rack plugin's parameters. */
export const RACK_PLUGIN_VERSION = 1;
/** How many macro knobs a rack has. */
export const MACRO_COUNT = 8;
/** The most branches (or bands) a rack has. */
export const MAX_RACK_BRANCHES = 4;
/** The most effects one branch holds. */
export const MAX_BRANCH_FX = 8;
/** The most things one macro can drive. */
export const MAX_MACRO_MAPPINGS = 32;
/** The longest name of a macro or a branch, in characters. */
export const RACK_NAME_MAX = 24;
/** A branch's level (dB) when it is turned right down: the minimum counts as silence. */
export const BRANCH_LEVEL_MIN_DB = -60;
/** The loudest a branch's level goes (dB). */
export const BRANCH_LEVEL_MAX_DB = 6;
/** The range of a rack's output gain (dB). */
export const RACK_GAIN_MIN_DB = -24;
export const RACK_GAIN_MAX_DB = 12;
/** The lowest and highest frequency a crossover may sit at (Hz). */
export const CROSSOVER_MIN_HZ = 20;
export const CROSSOVER_MAX_HZ = 20000;
/** Neighbouring crossovers keep at least this frequency ratio between them (a little under a semitone). */
export const CROSSOVER_MIN_RATIO = 1.05;

/** The id of macro `index` (0-based) among the rack plugin's parameters: `macro1` … `macro8`. */
export const macroParamId = (index: number): string => `macro${index + 1}`;

/** The macro number (0-based) a rack plugin parameter id stands for, or -1 when it is not a macro. */
export function macroIndexOfParam(paramId: string): number {
  const match = /^macro([1-8])$/.exec(paramId);
  return match ? Number(match[1]) - 1 : -1;
}

function macroSpecs(): ParamSpecs {
  const specs: ParamSpecs = {};
  for (let i = 0; i < MACRO_COUNT; i++) {
    specs[macroParamId(i)] = p.float(0, 1, 0, {
      label: `Macro ${i + 1}`,
      unit: '%',
      group: 'Macros',
      hint: 'A macro knob: it moves everything it is mapped to inside the rack, between the ranges you set',
    });
  }
  return specs;
}

/** The parameters of a rack slot's plugin: the eight macro knobs (0–1) and the output gain. */
export const RACK_PARAMS: ParamSpecs = {
  ...macroSpecs(),
  gain: p.float(RACK_GAIN_MIN_DB, RACK_GAIN_MAX_DB, 0, {
    label: 'Output',
    unit: 'dB',
    scale: 'db',
    group: 'Rack',
    hint: 'How loud the rack as a whole is (dB), after its branches are added up',
  }),
};

/** The plugin data of a new rack slot: macros at 0, output at 0 dB. */
export function makeRackPlugin(): PluginInstance {
  const params: Record<string, number> = { gain: 0 };
  for (let i = 0; i < MACRO_COUNT; i++) params[macroParamId(i)] = 0;
  return { pluginId: RACK_PLUGIN_ID, pluginVersion: RACK_PLUGIN_VERSION, params };
}

/** The fewest and most branches a split mode takes. */
export function branchCountRange(split: RackSplit): { min: number; max: number } {
  switch (split) {
    case 'parallel':
      return { min: 1, max: MAX_RACK_BRANCHES };
    case 'bands':
      return { min: 2, max: MAX_RACK_BRANCHES };
    case 'midside':
    case 'leftright':
      return { min: 2, max: 2 };
  }
}

const BAND_NAMES: Record<number, readonly string[]> = {
  2: ['Low', 'High'],
  3: ['Low', 'Mid', 'High'],
  4: ['Low', 'Low-mid', 'High-mid', 'High'],
};

/** The names a new branch gets: "Mid" and "Side", "Left" and "Right", the band names, or "Branch 1", "Branch 2" … */
export function defaultBranchNames(split: RackSplit, count: number): string[] {
  if (split === 'midside') return ['Mid', 'Side'].slice(0, count);
  if (split === 'leftright') return ['Left', 'Right'].slice(0, count);
  if (split === 'bands' && BAND_NAMES[count]) return [...(BAND_NAMES[count] as readonly string[])];
  if (split === 'parallel' && count === 1) return ['Chain'];
  return Array.from({ length: count }, (_, i) => `Branch ${i + 1}`);
}

/** Crossover frequencies (Hz) that split the spectrum sensibly into `bands` bands: lows, mids and highs. */
export function defaultCrossovers(bands: number): number[] {
  switch (bands) {
    case 2:
      return [500];
    case 3:
      return [200, 2500];
    case 4:
      return [120, 800, 5000];
    default:
      return [];
  }
}

/** An empty branch with a fresh id: 0 dB, centred, not muted. */
export function makeBranch(name: string, id: BranchId = newId.branch()): RackBranch {
  return { id, name, levelDb: 0, pan: 0, muted: false, solo: false, fx: [] };
}

/** Eight macros with their default names and nothing mapped. */
export function makeMacros(): RackMacro[] {
  return Array.from({ length: MACRO_COUNT }, (_, i) => ({ name: `Macro ${i + 1}`, mappings: [] }));
}

/** A new rack with `branchCount` empty branches (the least the split takes when it is 0 or less) and no mappings. */
export function makeRack(split: RackSplit = 'parallel', branchCount = 0): Rack {
  const range = branchCountRange(split);
  const count = Math.min(range.max, Math.max(range.min, branchCount || range.min));
  const names = defaultBranchNames(split, count);
  return {
    split,
    crossovers: split === 'bands' ? defaultCrossovers(count) : [],
    branches: names.map((name) => makeBranch(name)),
    macros: makeMacros(),
  };
}

/** A new effect slot (enabled, fully wet, no sidechain). */
export function makeFxSlot(plugin: PluginInstance, id: SlotId = newId.slot()): FxSlot {
  return { id, plugin, enabled: true, mix: 1, sidechain: null };
}

/** A new rack slot: the rack plugin and a rack of `branchCount` empty branches. */
export function makeRackSlot(split: RackSplit = 'parallel', branchCount = 0, id: SlotId = newId.slot()): FxSlot {
  return { ...makeFxSlot(makeRackPlugin(), id), rack: makeRack(split, branchCount) };
}

/** Whether the slot is an effect rack. */
export function isRackSlot(slot: Pick<FxSlot, 'plugin' | 'rack'>): slot is FxSlot & { rack: Rack } {
  return slot.plugin.pluginId === RACK_PLUGIN_ID && slot.rack !== undefined;
}

/** Whether two macro targets point at the same thing. */
export function sameMacroTarget(a: MacroTarget, b: MacroTarget): boolean {
  switch (a.kind) {
    case 'param':
      return b.kind === 'param' && a.slotId === b.slotId && a.paramId === b.paramId;
    case 'mix':
      return b.kind === 'mix' && a.slotId === b.slotId;
    case 'branch':
      return b.kind === 'branch' && a.branchId === b.branchId && a.param === b.param;
    case 'crossover':
      return b.kind === 'crossover' && a.index === b.index;
    case 'gain':
      return b.kind === 'gain';
  }
}
