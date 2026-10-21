/**
 * Effect racks: one effect slot of a mixer insert that holds a small graph of effects (see `docs/architecture.md`,
 * "Effect racks"). The slot's `plugin` is the built-in `agstudio.rack` effect, whose parameters are the eight macro
 * knobs and the output gain; everything else a rack is made of is here, in `FxSlot.rack`.
 */
import type { SlotId, BranchId } from './ids';
import type { FxSlot } from './mixer';

/**
 * How a rack splits its input into branches:
 * - `parallel`: every branch gets a copy of the input and the branches add up (a branch with no effects is the dry sound);
 * - `bands`: the input is cut into frequency bands with Linkwitz-Riley crossovers, one band per branch, lowest first;
 * - `midside`: the first branch hears the mid (what both sides share), the second the side (what differs between them);
 * - `leftright`: the first branch hears the left channel, the second the right one.
 */
export type RackSplit = 'parallel' | 'bands' | 'midside' | 'leftright';

/** What a macro does to a parameter as the macro knob moves from 0 to 1. */
export type MacroCurve = 'linear' | 'exponential' | 'inverted';

/** What a macro can drive inside its rack. Values of a mapping's `min` and `max` are in the target's own units. */
export type MacroTarget =
  /** A parameter of an effect in the rack (an enum is its option number, a switch is 0 or 1). */
  | { kind: 'param'; slotId: SlotId; paramId: string }
  /** The dry/wet mix of an effect in the rack (0–1). */
  | { kind: 'mix'; slotId: SlotId }
  /** The level (dB) or pan (−1…1) of a branch. */
  | { kind: 'branch'; branchId: BranchId; param: 'level' | 'pan' }
  /** One crossover frequency (Hz) of a `bands` rack; `index` 0 is the lowest. */
  | { kind: 'crossover'; index: number }
  /** The rack's own output gain (dB). */
  | { kind: 'gain' };

/** One thing a macro drives: where it goes, the range it sweeps and the shape of the sweep. */
export interface MacroMapping {
  target: MacroTarget;
  /** The target's value with the macro at 0. May be above `max` (the sweep then runs backwards). */
  min: number;
  /** The target's value with the macro at 1. */
  max: number;
  /**
   * linear: the knob and the parameter move together (along the parameter's own knob travel, so a frequency sweeps
   * evenly in octaves); exponential: slow at first, faster toward the end; inverted: linear, backwards.
   */
  curve: MacroCurve;
}

/** One of a rack's eight macro knobs: its name and everything it drives. The knob's value is a parameter of the rack's plugin. */
export interface RackMacro {
  name: string;
  mappings: MacroMapping[];
}

/** One branch of a rack: a serial chain of effects with a level, a pan and mute/solo of its own. */
export interface RackBranch {
  id: BranchId;
  name: string;
  /** Level in dB (−60 is silence). */
  levelDb: number;
  /** −1 (left) … 1 (right). */
  pan: number;
  muted: boolean;
  solo: boolean;
  /**
   * The effects in order. They are ordinary effect slots with ids that are unique in the whole insert, so an effect in a
   * rack is found, edited, saved and automated like one on the insert. They are never racks themselves and have no sidechain.
   */
  fx: FxSlot[];
}

/** The inside of a rack slot (`FxSlot.rack`). Its dry/wet is the slot's `mix`, its output gain a parameter of the slot's plugin. */
export interface Rack {
  split: RackSplit;
  /** Band edges in Hz, lowest first: one fewer than there are branches in a `bands` rack, none otherwise. */
  crossovers: number[];
  /** One to four branches, in order (the order of the bands, and of the mid and side). */
  branches: RackBranch[];
  /** Always eight, macro 1 first. */
  macros: RackMacro[];
}
