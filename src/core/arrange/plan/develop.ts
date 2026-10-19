import type { Style } from '../../beat/style';
import { PPQ, ticksPerBar } from '../../time/ppq';
import type { Project, Tick } from '../../model/types';
import { phraseEvents, type PhraseEvent } from '../phrases';
import type { SectionSpan } from '../sections';
import {
  boundaryRecipe,
  classifyBoundary,
  defaultEnding,
  endingRecipe,
  type BoundaryContext,
  type BoundaryRecipe,
  type EndingRecipe,
  type FxLevel,
} from '../transitions';
import { FILL_KINDS } from '../variants';
import { ADDS_DRUMS } from './clip-steps';
import { CrashPicker, DEFAULT_CRASH_SECONDS, crashLengthTicks } from './crashes';
import { type LaneAllocator } from './lanes';
import {
  automationOfTransitions,
  fxHeardAt,
  fxOfTransitions,
  placeCurve,
  placeFxSound,
  planCounts,
  rotateFills,
} from './transition-items';
import {
  eventSpan,
  type DevelopSection,
  type PlanCounts,
  type PlannedAutomation,
  type PlannedCrash,
  type PlannedFx,
  type SongEvent,
} from './types';

export interface DevelopOptions {
  style: Style;
  /** Phrase rules inside sections (fills, small changes). */
  fills: boolean;
  /** Boundary recipes (fills, gaps, FX, crashes, automation) and the ending. */
  transitions: boolean;
  fx: FxLevel;
  /** The range to develop [from, to); boundaries at both ends count. */
  from: Tick;
  to: Tick;
}

/** What's in the song already (develop doesn't add a second riser or fill where one is). */
export interface Existing {
  fx: { kind: string; at: Tick }[];
  /** Fills playing from their own clips: their spans. */
  fills: { from: Tick; to: Tick }[];
}

export interface DevelopPlan {
  sections: readonly DevelopSection[];
  boundaries: BoundaryRecipe[];
  ending: EndingRecipe | null;
  events: SongEvent[];
  fx: PlannedFx[];
  crashes: PlannedCrash[];
  automation: PlannedAutomation[];
  counts: PlanCounts;
  skipped: { fx: number; fills: number; crashes: number };
}

/** Existing FX within this many ticks (1 beat) of a planned one of the same kind are kept instead. */
const SAME_FX_WINDOW_TICKS = PPQ;
/** A song ending gets an ending recipe only when it ends at least this loud (a quiet outro already is one). */
const MIN_ENDING_ENERGY = 3;

/**
 * Plans fills, small changes and transitions for existing sections. Existing FX within 1 beat of a
 * planned one of the same kind, crashes closer than 4 bars and fills already played from their own
 * clips are kept instead of adding more. `lanes` knows what the playlist already holds.
 */
export function planDevelop(
  p: Project,
  sections: readonly DevelopSection[],
  opts: DevelopOptions,
  existing: Existing,
  lanes: LaneAllocator,
): DevelopPlan {
  const timeSig = p.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const context: BoundaryContext = {
    bpm: p.transport.bpm,
    beatsPerBar: timeSig.num * (4 / timeSig.den),
    barTicks,
    style: opts.style,
    fx: opts.fx,
  };
  const rotation = { fill: 0 };
  const spans = sectionSpansOf(sections);
  const endChanges = new Map<number, PhraseEvent[]>();
  const boundaries = planBoundaries(spans, sections, opts, context, rotation, endChanges);
  const ending = planEnding(spans, opts, context);
  const last = spans[spans.length - 1];
  if (ending && last) endChanges.set(last.index, ending.end);

  const events = planEvents(spans, sections, endChanges, opts, barTicks, rotation);
  const { kept, fillsSkipped } = keepClearOfFills(events, existing.fills);
  rotateFills(kept, spans, opts.style);

  const { fx, skipped: fxSkipped } = planFx(boundaries, ending, existing, lanes);
  const picker = new CrashPicker(
    barTicks,
    existing.fx.filter((x) => x.kind === 'crash').map((x) => x.at),
  );
  picker.offerTransitions(boundaries, ending);
  const crashes = picker.placeOnLanes(lanes, crashLengthTicks(DEFAULT_CRASH_SECONDS, p.transport.bpm));
  const automation = automationOfTransitions(boundaries, ending)
    .filter((a) => a.start >= 0)
    .map((a) => placeCurve(a, lanes));

  return {
    sections,
    boundaries,
    ending,
    events: kept,
    fx,
    crashes,
    automation,
    counts: planCounts(kept, boundaries),
    skipped: { fx: fxSkipped, fills: fillsSkipped, crashes: picker.skipped },
  };
}

/** The existing sections as the spans the recipes work on (no patterns: the song's clips already play). */
function sectionSpansOf(sections: readonly DevelopSection[]): SectionSpan[] {
  return sections.map((s, index) => ({
    ...s,
    index,
    play: [],
    without: [],
    vary: 'auto',
    transitionIn: 'auto',
    fill: 'auto',
  }));
}

/**
 * The boundary recipes for the sections whose start is in range, each also filling in the changes
 * that end the section before it (`endChanges`, by section index).
 */
function planBoundaries(
  spans: readonly SectionSpan[],
  sections: readonly DevelopSection[],
  opts: DevelopOptions,
  context: BoundaryContext,
  rotation: { fill: number },
  endChanges: Map<number, PhraseEvent[]>,
): BoundaryRecipe[] {
  const boundaries: BoundaryRecipe[] = [];
  if (!opts.transitions) return boundaries;
  spans.forEach((b, i) => {
    if (b.from < opts.from || b.from > opts.to) return;
    const a = i > 0 ? spans[i - 1]! : null;
    if (!a && b.from !== 0) return;
    const aWithCaps = a ? { ...a, caps: sections[i - 1]!.caps } : null;
    const recipe = boundaryRecipe(classifyBoundary(a, b), b.from, aWithCaps, b, context, rotation);
    boundaries.push(recipe);
    if (a) endChanges.set(i - 1, recipe.end);
  });
  return boundaries;
}

/** The song's end gets an ending only when it ends loud (a quiet outro already is one). */
function planEnding(
  spans: readonly SectionSpan[],
  opts: DevelopOptions,
  context: BoundaryContext,
): EndingRecipe | null {
  const last = spans[spans.length - 1];
  if (!opts.transitions || !last) return null;
  if (opts.to < last.to || last.energy < MIN_ENDING_ENERGY) return null;
  return endingRecipe(defaultEnding(opts.style), last, context);
}

/** Each section's changes: the transition's end changes plus, when asked, the phrase rules'. Kept within the range. */
function planEvents(
  spans: readonly SectionSpan[],
  sections: readonly DevelopSection[],
  endChanges: ReadonlyMap<number, PhraseEvent[]>,
  opts: DevelopOptions,
  barTicks: Tick,
  rotation: { fill: number },
): SongEvent[] {
  const events: SongEvent[] = [];
  // Changes stay within the range, plus a bar on each side for transitions.
  const within = { from: opts.from - barTicks, to: opts.to + barTicks };
  spans.forEach((s, i) => {
    const end = endChanges.get(i) ?? [];
    const section = sections[i]!;
    const result = opts.fills
      ? phraseEvents(
          {
            bars: s.bars,
            barTicks,
            energy: s.energy,
            style: opts.style,
            vary: 'auto',
            fill: 'auto',
            caps: section.caps,
            loopBars: section.loopBars,
            index: i,
          },
          end,
          rotation,
        )
      : { events: end, crashes: [] };
    for (const e of result.events) {
      const event: SongEvent = { ...e, from: e.from + s.from, to: e.to + s.from, section: i, within };
      const span = eventSpan(event);
      if (span.to <= span.from) continue;
      events.push(event);
    }
  });
  return events;
}

/**
 * Fills already played from their own clips stay the fill there: nothing adds drums under them
 * (busier hats and stutters go around them).
 */
function keepClearOfFills(
  events: readonly SongEvent[],
  existingFills: Existing['fills'],
): { kept: SongEvent[]; fillsSkipped: number } {
  let fillsSkipped = 0;
  const kept: SongEvent[] = [];
  for (const event of events) {
    const span = eventSpan(event);
    const clashes = existingFills.filter((f) => f.from < span.to && f.to > span.from);
    if (!clashes.length || !ADDS_DRUMS.has(event.kind)) {
      kept.push(event);
      continue;
    }
    if (event.kind !== 'double-hats') {
      if (FILL_KINDS.has(event.kind)) fillsSkipped++;
      continue;
    }
    kept.push(...doubleHatsAround(event, span, clashes));
  }
  return { kept, fillsSkipped };
}

/** Double hats in the gaps between the fills they would run into. */
function doubleHatsAround(
  event: SongEvent,
  span: { from: Tick; to: Tick },
  clashes: readonly { from: Tick; to: Tick }[],
): SongEvent[] {
  const pieces: SongEvent[] = [];
  let at = span.from;
  for (const fill of [...clashes].sort((a, b) => a.from - b.from)) {
    if (fill.from > at) pieces.push({ ...event, from: at, to: fill.from, within: { from: at, to: fill.from } });
    at = Math.max(at, fill.to);
  }
  if (at < span.to) pieces.push({ ...event, from: at, to: span.to, within: { from: at, to: span.to } });
  return pieces;
}

/** FX sounds on lanes; a kind already in the song within a beat is skipped (and counted). */
function planFx(
  boundaries: readonly BoundaryRecipe[],
  ending: EndingRecipe | null,
  existing: Existing,
  lanes: LaneAllocator,
): { fx: PlannedFx[]; skipped: number } {
  let skipped = 0;
  const fx: PlannedFx[] = [];
  for (const sound of fxOfTransitions(boundaries, ending)) {
    const length = Math.round(sound.beats * PPQ);
    const at = fxHeardAt(sound, length);
    if (existing.fx.some((x) => x.kind === sound.kind && Math.abs(x.at - at) <= SAME_FX_WINDOW_TICKS)) {
      skipped++;
      continue;
    }
    if (sound.start < 0) continue;
    fx.push(placeFxSound(sound, lanes));
  }
  return { fx, skipped };
}
