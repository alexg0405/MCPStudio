/** Helpers for the MIDI effects' tests: notes on a 1/16 grid, a plain context, and running one effect or a chain by id. */
import type { ParamValue } from '@agstudio/sdk/params';
import type { ChordSymbol } from '../harmony/chord';
import type { KeyLike } from '../harmony/scale';
import type { MidiFxSlot, MidiFxSlotId } from '../model/types';
import { PPQ, constantTempo } from '../time/ppq';
import { activeEffects, runChain, type FxSpan } from './chain';
import type { FxContext, FxNote } from './types';

/** Ticks in a 1/16 step. */
export const STEP = 240;

/** A note starting at `step` 1/16 steps and lasting `steps` steps (fractions allowed). */
export function noteAt(id: string, step: number, steps: number, key: number, velocity = 0.8): FxNote {
  return { id, start: step * STEP, end: (step + steps) * STEP, key, velocity };
}

/** What a test can set about the context: the song key, the chords by start tick, the tempo and whether play is live. */
export interface TestContext {
  key?: KeyLike;
  /** The chord from each tick on (the last entry whose tick is not after the note's start). */
  chords?: readonly { from: number; chord: ChordSymbol }[];
  bpm?: number;
  live?: boolean;
}

/** A context for tests: constant tempo (120 BPM by default), no automation. */
export function testContext(options: TestContext = {}): FxContext {
  const tempo = constantTempo(options.bpm ?? 120);
  return {
    key: options.key ?? null,
    chordAt: (tick) => {
      let found: ChordSymbol | null = null;
      for (const entry of options.chords ?? []) if (entry.from <= tick) found = entry.chord;
      return found;
    },
    msToTicks: (ms, tick) => ms / 1000 / tempo.secondsPerTick(tick),
    live: options.live ?? false,
  };
}

/** A slot of an effect with the given settings (the rest default). */
export function slotOf(effect: string, params: Record<string, ParamValue> = {}, id = `mfx_${effect}`): MidiFxSlot {
  return { id: id as MidiFxSlotId, effect, enabled: true, params };
}

/** Runs a chain of slots on notes over a span (a bar by default) and returns the notes sorted as the chain gives them. */
export function runSlots(slots: readonly MidiFxSlot[], input: readonly FxNote[], span: FxSpan = { from: 0, to: 4 * PPQ }, context: FxContext = testContext()): FxNote[] {
  return runChain(activeEffects(slots), input, span, context);
}

/** Runs one effect with the given settings. */
export function runOne(effect: string, params: Record<string, ParamValue>, input: readonly FxNote[], span?: FxSpan, context?: FxContext): FxNote[] {
  return runSlots([slotOf(effect, params)], input, span, context);
}

/** The starts of notes as 1/16 steps (fractions kept), in the order given. */
export function stepsOf(notes: readonly FxNote[]): number[] {
  return notes.map((note) => note.start / STEP);
}

/** The keys of notes, in the order given. */
export function keysOf(notes: readonly FxNote[]): number[] {
  return notes.map((note) => note.key);
}
