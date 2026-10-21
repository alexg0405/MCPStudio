/**
 * The MIDI effects a channel can have, by id: what the window, the AI and the repair look them up in. Adding an effect means
 * writing its file in `effects/` and listing it here.
 */
import { defaultValues, resolveValues, sanitize, type ParamValue } from '@agstudio/sdk/params';
import type { MidiFxSlot } from '../model/types';
import { arpeggiator } from './effects/arpeggiator';
import { chord } from './effects/chord';
import { echo } from './effects/echo';
import { humanize } from './effects/humanize';
import { noteLength } from './effects/length';
import { randomNotes } from './effects/random';
import { repeat } from './effects/repeat';
import { scale } from './effects/scale';
import { transpose } from './effects/transpose';
import { velocityCurve } from './effects/velocity';
import type { MidiFxDef } from './types';

/** The most MIDI effects one channel may have in its chain. */
export const MAX_MIDI_FX = 8;

/** Every MIDI effect, in the order the "add" menu lists them. */
export const MIDI_FX: readonly MidiFxDef[] = [arpeggiator, chord, scale, repeat, echo, humanize, velocityCurve, transpose, noteLength, randomNotes];

const byId = new Map(MIDI_FX.map((def) => [def.id, def]));

/** The effect with this id, or undefined for an id this version does not know (such a slot is kept and skipped). */
export function midiFxDef(id: string): MidiFxDef | undefined {
  return byId.get(id);
}

/** True when `id` names an effect. */
export function isMidiFxId(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id);
}

/** An effect's settings with every param at its default. */
export function defaultFxParams(def: MidiFxDef): Record<string, ParamValue> {
  return defaultValues(def.params);
}

/** A slot's settings with the defaults filled in and every value checked against its param (an out-of-range number is clamped). */
export function slotValues(def: MidiFxDef, slot: Pick<MidiFxSlot, 'params'>): Record<string, ParamValue> {
  return resolveValues(def.params, slot.params) as Record<string, ParamValue>;
}

/** One value checked against a param of the effect (the default when the param is unknown or the value is the wrong kind). */
export function checkedFxValue(def: MidiFxDef, paramId: string, value: unknown): ParamValue | undefined {
  const spec = def.params[paramId];
  return spec ? sanitize(spec, value) : undefined;
}
