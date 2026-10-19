/**
 * One transition at a bar: a whole recipe (a rise, a fall… or "auto", which reads what the sections on both
 * sides call for) or a single element of one (a fill, a gap, a riser, an impact, a crash, a filter sweep).
 * It runs inside one History recipe like the other arranger operations in `run.ts`, which re-exports this.
 */
import type { Draft } from 'immer';
import { applyEditsInPlace, laneAllocatorFor, placeAutomation, placeCrashes, placeFx, type ApplyEnv } from '@core/arrange/apply';
import { existingFx, inferSections, type InferredSection } from '@core/arrange/infer';
import { FILL_ROTATION } from '@core/arrange/phrases';
import { CRASH_LANE, FX_LANE, type PlannedAutomation, type SongEvent } from '@core/arrange/plan';
import {
  boundaryRecipe,
  classifyBoundary,
  riserBars,
  type AutomationItem,
  type BoundaryKind,
  type FxPlacement,
} from '@core/arrange/transitions';
import { inferStyle, type Style } from '@core/beat/style';
import { fxBeats } from '@core/model/fx';
import type { ClipId, Project, Tick, VariantKind } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';
import { applyEnvFor } from './env';
import { plain } from './plain';
import type { RunResult, SpanGuard } from './run';

const BEAT = 960;

export const TRANSITION_KINDS = [
  'auto',
  'rise',
  'lift',
  'same',
  'dip',
  'fall',
  'fill',
  'gap',
  'riser',
  'reverse_crash',
  'impact',
  'downlifter',
  'crash',
  'filter_open',
  'filter_close',
  'reverb_throw',
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export interface TransitionInput {
  /** The downbeat it leads into. */
  at: Tick;
  kind: TransitionKind;
  /** Riser, downlifter and filter lengths. */
  bars?: number;
  /** Fill and gap lengths. */
  beats?: number;
  style?: Style;
}

/** The kinds that are whole recipes between two sections; the others are one element each. */
const RECIPE_KINDS: readonly TransitionKind[] = ['auto', 'rise', 'lift', 'same', 'dip', 'fall'];

/** The sections on both sides of `at` (one section split there when `at` falls inside it). */
function sidesAt(sections: readonly InferredSection[], at: Tick): { a: InferredSection | null; b: InferredSection } | null {
  const bi = sections.findIndex((x) => x.from === at);
  if (bi >= 0) return { a: bi > 0 ? sections[bi - 1]! : null, b: sections[bi]! };
  const inside = sections.find((x) => x.from < at && at < x.to);
  if (!inside) return null;
  const bars = (t: Tick) => (t - inside.from) / ((inside.to - inside.from) / inside.bars);
  return {
    a: { ...inside, to: at, bars: Math.max(1, Math.round(bars(at))) },
    b: { ...inside, from: at, bars: Math.max(1, inside.bars - Math.round(bars(at))) },
  };
}

type Sides = NonNullable<ReturnType<typeof sidesAt>>;

/** What a transition adds, before it is placed on the song. */
interface TransitionParts {
  /** Changes to the drums and bass (fills, gaps). */
  events: Omit<SongEvent, 'section'>[];
  fx: FxPlacement[];
  /** The velocity (0–1) of a crash on the downbeat, or null for none. */
  crash: number | null;
  automation: AutomationItem[];
  /** A plain name for the change line, e.g. "a rise into “Drop”". */
  what: string;
}

/** What every part builder reads. */
interface TransitionContext {
  input: TransitionInput;
  style: Style;
  bpm: number;
  beatsPerBar: number;
  /** Ticks in one bar. */
  bar: Tick;
  /** The downbeat the transition leads into, snapped to a beat. */
  at: Tick;
}

/** A length in beats from the input (or the default), kept between 1 and 16. */
const beatsOf = (input: TransitionInput, fallback: number) => Math.max(1, Math.min(16, Math.round(input.beats ?? fallback)));

/** A length in bars from the input (or the default), kept between 1 and 8. */
const barsOf = (input: TransitionInput, fallback: number) => Math.max(1, Math.min(8, Math.round(input.bars ?? fallback)));

/** A whole recipe between the two sections (the kind "auto" picks the one their energies call for). */
function recipeParts(ctx: TransitionContext, sides: Sides): TransitionParts {
  const { input, at } = ctx;
  const kind: BoundaryKind = input.kind === 'auto' ? classifyBoundary(sides.a, sides.b) : (input.kind as BoundaryKind);
  const recipeContext = { bpm: ctx.bpm, beatsPerBar: ctx.beatsPerBar, barTicks: ctx.bar, style: ctx.style, fx: 'auto' as const };
  const recipe = boundaryRecipe(kind, at, sides.a ? { ...sides.a, fill: 'auto' } : null, sides.b, recipeContext, { fill: 0 });
  const sectionStart = sides.a?.from ?? at;
  return {
    events: recipe.end.map((e) => ({ ...e, from: e.from + sectionStart, to: e.to + sectionStart })),
    fx: recipe.fx,
    crash: recipe.crash,
    automation: recipe.automation,
    what: `a ${kind} into “${sides.b.name}”`,
  };
}

/** The reverb throw: the send opens for one beat and snaps back. */
function reverbThrowItem(start: Tick, length: Tick): AutomationItem {
  return {
    purpose: 'throw',
    target: { kind: 'throw' },
    start,
    length,
    points: [
      { at: 0, value: 'throw' },
      { at: length, value: 'throw' },
      { at: length, value: 'neutral' },
    ],
  };
}

/** A high-cut that opens from dull to neutral. */
function filterOpenItem(bus: 'chords' | 'lead', start: Tick, length: Tick): AutomationItem {
  return {
    purpose: 'filter-open',
    target: { kind: 'eq', bus, band: 'high-cut' },
    start,
    length,
    points: [
      { at: 0, value: 1200, tension: 0.35 },
      { at: length, value: 'neutral' },
    ],
  };
}

/** A high-cut that closes down toward the downbeat, then snaps back to neutral. */
function filterCloseItem(bus: 'chords' | 'lead', start: Tick, length: Tick): AutomationItem {
  return {
    purpose: 'filter-open',
    target: { kind: 'eq', bus, band: 'high-cut' },
    start,
    length,
    points: [
      { at: 0, value: 'neutral', tension: -0.35 },
      { at: length, value: 900 },
      { at: length, value: 'neutral' },
    ],
  };
}

/** The automation of a filter sweep or a reverb throw: one curve per bus. */
function sweepAutomation(ctx: TransitionContext, kind: 'filter_open' | 'filter_close' | 'reverb_throw'): AutomationItem[] {
  const { input, bar, at } = ctx;
  if (kind === 'reverb_throw') {
    const length = BEAT;
    return [reverbThrowItem(at - length, length)];
  }
  const buses = ['chords', 'lead'] as const;
  if (kind === 'filter_open') {
    const length = barsOf(input, 4) * bar;
    return buses.map((bus) => filterOpenItem(bus, at, length));
  }
  const length = barsOf(input, 2) * bar;
  return buses.map((bus) => filterCloseItem(bus, at - length, length));
}

/** One element of a transition: a fill, a gap, an FX hit, a crash or a sweep. */
function elementParts(ctx: TransitionContext, sides: Sides | null): TransitionParts {
  const { input, style, bpm, beatsPerBar, at } = ctx;
  const only = (part: Partial<Omit<TransitionParts, 'what'>>): TransitionParts => ({
    events: [],
    fx: [],
    crash: null,
    automation: [],
    what: input.kind.replace(/_/g, ' '),
    ...part,
  });
  switch (input.kind) {
    case 'fill': {
      const fillKind: VariantKind = FILL_ROTATION[style][0]!;
      return only({ events: [{ kind: fillKind, from: at - beatsOf(input, 2) * BEAT, to: at, energy: sides?.a?.energy ?? 4, why: 'end' }] });
    }
    case 'gap':
      return only({ events: [{ kind: 'gap', from: at - beatsOf(input, 1) * BEAT, to: at, energy: 4, why: 'end' }] });
    case 'riser': {
      const beats = barsOf(input, riserBars(bpm, beatsPerBar)) * beatsPerBar;
      return only({ fx: [{ kind: 'riser', beats, start: at - beats * BEAT, gainDb: -4 }] });
    }
    case 'reverse_crash':
      return only({ fx: [{ kind: 'reverse-crash', beats: beatsOf(input, 4), start: at - beatsOf(input, 4) * BEAT, gainDb: -3 }] });
    case 'impact':
      return only({ fx: [{ kind: 'impact', beats: fxBeats('impact', bpm), start: at, gainDb: -2 }] });
    case 'downlifter':
      return only({ fx: [{ kind: 'downlifter', beats: barsOf(input, 1) * beatsPerBar, start: at, gainDb: -8 }] });
    case 'crash':
      return only({ crash: 0.95 });
    case 'filter_open':
    case 'filter_close':
    case 'reverb_throw':
      return only({ automation: sweepAutomation(ctx, input.kind) });
    default:
      return only({});
  }
}

/** The parts of the transition, or null for a recipe between sections when there is no section at that bar. */
function partsFor(ctx: TransitionContext, sides: Sides | null): TransitionParts | null {
  if (!RECIPE_KINDS.includes(ctx.input.kind)) return elementParts(ctx, sides);
  return sides ? recipeParts(ctx, sides) : null;
}

/** The song span a transition touches (from its first edit to its last), for the span guard and the result. */
function spanOf(at: Tick, parts: TransitionParts): { lo: Tick; hi: Tick } {
  const lo = Math.min(at, ...parts.events.map((e) => e.from), ...parts.fx.map((f) => f.start), ...parts.automation.map((a) => a.start));
  const hi = Math.max(at, ...parts.events.map((e) => e.to), ...parts.automation.map((a) => a.start + a.length));
  return { lo, hi };
}

/** The clips a transition made or changed, by kind. */
interface PlacedClips {
  changed: ClipId[];
  fx: ClipId[];
  crash: ClipId[];
  automation: ClipId[];
}

/**
 * Puts the parts on the song. FX and crashes the song already has near the downbeat (within a beat) are not
 * doubled; each new clip goes on a lane that is free for its span.
 */
function placeParts(d: Draft<Project>, env: ApplyEnv, ctx: TransitionContext, parts: TransitionParts): PlacedClips {
  const { at, bar } = ctx;
  const changed = applyEditsInPlace(d, parts.events, env);
  const after = plain(d);
  const lanes = laneAllocatorFor(after);
  const there = existingFx(after, env.variant);
  const fxClips = placeFx(
    d,
    parts.fx
      .filter((f) => {
        const hitAt = f.kind === 'riser' || f.kind === 'reverse-crash' ? f.start + f.beats * BEAT : f.start;
        return f.start >= 0 && !there.some((x) => x.kind === f.kind && Math.abs(x.at - hitAt) <= BEAT);
      })
      .map((f) => ({ ...f, length: Math.round(f.beats * BEAT), lane: lanes.place(FX_LANE[f.kind], f.start, f.start + f.beats * BEAT) })),
    env,
  );
  const hasCrashNearby = there.some((x) => x.kind === 'crash' && Math.abs(x.at - at) <= BEAT);
  const crashClips =
    parts.crash !== null && !hasCrashNearby ? placeCrashes(d, [{ at, velocity: parts.crash, lane: lanes.place(CRASH_LANE, at, at + 4 * bar) }], env) : [];
  const autoClips = placeAutomation(
    d,
    parts.automation.filter((a) => a.start >= 0).map((a): PlannedAutomation => ({ ...a, lane: lanes.place('Automation', a.start, a.start + a.length) })),
    env,
    { skipBusy: true },
  );
  return { changed, fx: fxClips, crash: crashClips, automation: autoClips };
}

/** One transition at a bar: a whole recipe (auto or a kind), or one element of one. */
export function transitionInDraft(d: Draft<Project>, s: Services, base: Project, input: TransitionInput, guard?: SpanGuard): RunResult {
  const p = d as unknown as Project;
  const style = input.style ?? inferStyle(p);
  const bar = ticksPerBar(p.transport.timeSig);
  const at = Math.max(0, Math.round(input.at / BEAT) * BEAT);
  const { env, changes: made } = applyEnvFor(d, s, base, style, { create: true });
  const sides = sidesAt(inferSections(plain(d), env.variant), at);
  const ctx: TransitionContext = {
    input,
    style,
    bpm: p.transport.bpm,
    beatsPerBar: p.transport.timeSig.num * (4 / p.transport.timeSig.den),
    bar,
    at,
  };
  const parts = partsFor(ctx, sides);
  if (!parts) {
    return { changes: [], warnings: [`there is no section at bar ${at / bar + 1} to lead into`], touched: null, clipIds: [], findings: [] };
  }
  const { lo, hi } = spanOf(at, parts);
  guard?.(Math.max(0, lo), hi, 'transition');
  const placed = placeParts(d, env, ctx, parts);
  const clipIds = [...placed.changed, ...placed.fx, ...placed.crash, ...placed.automation];
  const where = `at bar ${at / bar + 1}`;
  const what = parts.what;
  return {
    changes: clipIds.length ? [`Added ${what} ${where}`, ...made] : [`${what[0]!.toUpperCase()}${what.slice(1)} ${where}: already there (nothing added)`],
    warnings: [],
    touched: { from: Math.max(0, lo), to: hi },
    clipIds,
    findings: [],
  };
}
