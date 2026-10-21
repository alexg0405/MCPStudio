/**
 * Running a channel's chain of MIDI effects on notes: each active effect in turn, every one asked only for the span of time
 * that can still reach the span the caller wants. Pure: the same notes, chain and context always give the same notes.
 */
import type { ParamValue } from '@agstudio/sdk/params';
import type { MidiFxSlot } from '../model/types';
import { byStartThenKey } from './note-utils';
import { hashText } from './random';
import { midiFxDef, slotValues } from './registry';
import type { FxContext, FxNote, FxReach, FxRun, MidiFxDef } from './types';

/** An enabled effect of a chain whose id is known, with its settings filled in. */
export interface ActiveFx {
  slot: MidiFxSlot;
  def: MidiFxDef;
  values: Record<string, ParamValue>;
  /** The slot's `seed` param (0 for effects without one) mixed with the effect's id. */
  seed: number;
}

/** A stretch of the timeline, in ticks: from (included) to (excluded). */
export interface FxSpan {
  from: number;
  to: number;
}

/** The effects of a chain that do something: not bypassed and known to this version (a slot of an unknown effect is skipped). */
export function activeEffects(slots: readonly MidiFxSlot[] | undefined): ActiveFx[] {
  const active: ActiveFx[] = [];
  for (const slot of slots ?? []) {
    const def = midiFxDef(slot.effect);
    if (!def || !slot.enabled) continue;
    const values = slotValues(def, slot);
    const seed = (Number(values.seed ?? 0) ^ hashText(def.id)) >>> 0;
    active.push({ slot, def, values, seed });
  }
  return active;
}

/** How far the whole chain can move a note sooner or later than where it came in, in ticks. */
export function chainReach(active: readonly ActiveFx[]): FxReach {
  const total: FxReach = { before: 0, after: 0 };
  for (const effect of active) {
    const reach = effect.def.reach(effect.values);
    total.before += reach.before;
    total.after += reach.after;
  }
  return total;
}

/** The run an effect gets: a numeric param reads its automation at the tick when a clip drives it, else the slot's own value. */
function runFor(effect: ActiveFx, span: FxSpan, context: FxContext): FxRun {
  return {
    from: span.from,
    to: span.to,
    values: effect.values,
    seed: effect.seed,
    context,
    param(name, tick) {
      const automated = context.automated?.(effect.slot.id, name, tick);
      return automated ?? Number(effect.values[name]);
    },
  };
}

/**
 * Runs the chain on `input` and returns the notes that start in `span`, in time order. `input` must hold every note that can
 * matter: the ones in the span, the ones held across it, and those within the chain's reach before it.
 *
 * Each effect is asked for a span widened by what the effects after it can move notes by, so a note an effect makes outside the
 * span asked for is not wasted work for the next one. Between effects, notes that ended before the widest span are dropped.
 */
export function runChain(active: readonly ActiveFx[], input: readonly FxNote[], span: FxSpan, context: FxContext): FxNote[] {
  const reach = chainReach(active);
  const spans = stageSpans(active, span);
  let notes = [...input].sort(byStartThenKey);
  active.forEach((effect, stage) => {
    const asked = spans[stage] as FxSpan;
    const made = effect.def.run(notes, runFor(effect, asked, context));
    const keepFrom = asked.from - reach.after;
    notes = made.filter((note) => note.end > keepFrom && note.start < asked.to).sort(byStartThenKey);
  });
  return notes.filter((note) => note.start >= span.from && note.start < span.to);
}

/** The span each effect is asked for: the wanted span widened by the reach of the effects after it. */
function stageSpans(active: readonly ActiveFx[], span: FxSpan): FxSpan[] {
  const spans: FxSpan[] = new Array(active.length);
  let before = 0;
  let after = 0;
  for (let stage = active.length - 1; stage >= 0; stage--) {
    spans[stage] = { from: span.from - after, to: span.to + before };
    const reach = (active[stage] as ActiveFx).def.reach((active[stage] as ActiveFx).values);
    before += reach.before;
    after += reach.after;
  }
  return spans;
}
