/**
 * Turns the chords of one voice into the notes and rests of each bar: chords are cut at bar lines and where the meter asks
 * (see `split.ts`) and tied across the cuts, gaps become rests, and a bar with nothing in voice 1 is one whole-bar rest.
 * Beats written as triplets are cut in "written ticks" (a third longer than they sound) and carry a tuplet mark.
 */
import type { Tick } from '../model/types';
import { drumPlace } from './drums';
import { flagCount } from './durations';
import { levelAt, type Meter } from './meter';
import { splitSpan, type Piece, type SplitRules } from './split';
import { positionOf } from './spelling';
import type { ChordItem, Head, Item, NoteValue, RestItem, Spelling, TupletInfo } from './types';
import type { VoiceEvent } from './voices';
import type { QuantizedNote } from './quantize';

/** What building a voice's bars needs to know. */
export interface BuildContext {
  meter: Meter;
  tripletUnits: ReadonlyMap<number, Tick>;
  windowTicks: Tick;
  isPercussion: boolean;
  spell(key: number): Spelling;
}

/** Written ticks per sounding tick inside a triplet (three in the time of two). */
const TRIPLET_STRETCH = 1.5;

/** The pieces a span of one bar is cut into, with the tuplet each belongs to. */
interface CutPiece extends Piece {
  tuplet: TupletInfo | null;
}

function straightRules(meter: Meter, isRest: boolean): SplitRules {
  return {
    levelOf: (position) => levelAt(meter, position),
    quantum: 60,
    isRest,
    allowsBeatCrossing: meter.divisionTicks * 2 === (meter.groupEdges[1] as number),
  };
}

/** Rules inside a triplet: the written window is a group of three divisions. */
function tripletRules(windowTicks: Tick, isRest: boolean): SplitRules {
  const written = windowTicks * TRIPLET_STRETCH;
  return {
    levelOf: (position) => {
      if (position === 0) return 2;
      let division = written / 3;
      for (let level = 3; level < 9; level++) {
        if (position % division === 0) return level;
        division /= 2;
      }
      return 9;
    },
    quantum: 60,
    isRest,
    allowsBeatCrossing: false,
  };
}

/** The edges of the triplet windows that touch [from, to), plus from and to, as the places the span is cut at first. */
function windowCuts(from: Tick, to: Tick, ctx: BuildContext): Tick[] {
  const cuts = [from];
  const first = Math.floor(from / ctx.windowTicks);
  const last = Math.floor((to - 1) / ctx.windowTicks);
  for (let index = first; index <= last; index++) {
    if (!ctx.tripletUnits.has(index)) continue;
    for (const edge of [index * ctx.windowTicks, (index + 1) * ctx.windowTicks]) {
      if (edge > from && edge < to && !cuts.includes(edge)) cuts.push(edge);
    }
  }
  cuts.push(to);
  return cuts.sort((a, b) => a - b);
}

/** Cuts [from, to) (absolute ticks inside one bar that starts at `barStart`) into readable pieces. */
function cutSpan(from: Tick, to: Tick, barStart: Tick, isRest: boolean, ctx: BuildContext): CutPiece[] {
  const out: CutPiece[] = [];
  const cuts = windowCuts(from, to, ctx);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    const windowIndex = Math.floor(a / ctx.windowTicks);
    const windowStart = windowIndex * ctx.windowTicks;
    const isWholeWindow = a === windowStart && b === windowStart + ctx.windowTicks;
    if (ctx.tripletUnits.has(windowIndex) && !isWholeWindow) {
      const tuplet: TupletInfo = { actual: 3, normal: 2, spanTick: windowStart - barStart, spanTicks: ctx.windowTicks };
      const written = splitSpan((a - windowStart) * TRIPLET_STRETCH, (b - windowStart) * TRIPLET_STRETCH, tripletRules(ctx.windowTicks, isRest));
      for (const piece of written) {
        out.push({ from: windowStart + piece.from / TRIPLET_STRETCH, to: windowStart + piece.to / TRIPLET_STRETCH, value: piece.value, tuplet });
      }
      continue;
    }
    for (const piece of splitSpan(a - barStart, b - barStart, straightRules(ctx.meter, isRest))) {
      out.push({ from: piece.from + barStart, to: piece.to + barStart, value: piece.value, tuplet: null });
    }
  }
  return out;
}

/** A head for a quantized note. */
function headOf(note: QuantizedNote, ctx: BuildContext, flags: { tiesToNext: boolean; tiedFromPrevious: boolean }): Head {
  const spelling = ctx.spell(note.note.key);
  const place = ctx.isPercussion ? drumPlace(note.note.key) : null;
  return {
    noteId: note.note.id,
    channelId: note.note.channelId,
    key: note.note.key,
    velocity: note.note.velocity,
    spelling,
    position: place ? place.position : positionOf(spelling),
    accidental: null,
    isCourtesy: false,
    shape: place ? place.shape : 'normal',
    isDisplaced: false,
    isOpen: place ? place.isOpen : false,
    tiesToNext: flags.tiesToNext,
    tiedFromPrevious: flags.tiedFromPrevious,
  };
}

/** The heads of an event for one piece: lowest first, and a drum written twice at one place only once. */
function headsFor(event: VoiceEvent, ctx: BuildContext, flags: { tiesToNext: boolean; tiedFromPrevious: boolean }): Head[] {
  const heads = event.notes.map((note) => headOf(note, ctx, flags));
  heads.sort((a, b) => a.position - b.position || a.key - b.key);
  if (!ctx.isPercussion) return heads;
  return heads.filter((head, i) => i === 0 || head.position !== (heads[i - 1] as Head).position || head.shape !== (heads[i - 1] as Head).shape);
}

function chordItem(piece: CutPiece, barStart: Tick, heads: Head[]): ChordItem {
  return {
    kind: 'chord',
    tick: piece.from - barStart,
    ticks: piece.to - piece.from,
    value: piece.value,
    tuplet: piece.tuplet,
    heads,
    stem: 'up',
    beamId: null,
    flags: flagCount(piece.value),
    dynamic: null,
    lyric: null,
  };
}

function restItem(piece: CutPiece, barStart: Tick, isWholeBar: boolean): RestItem {
  return { kind: 'rest', tick: piece.from - barStart, ticks: piece.to - piece.from, value: piece.value, tuplet: piece.tuplet, isWholeBar };
}

const WHOLE_VALUE: NoteValue = { base: 1, dots: 0 };

/**
 * The items of one voice in the bar [barStart, barEnd): its chords cut and tied, and rests in the gaps. Voice 2 with no
 * chords in the bar gives no items (nothing is drawn for it); voice 1 gives a whole-bar rest.
 */
export function buildBar(events: readonly VoiceEvent[], barStart: Tick, barEnd: Tick, voiceNumber: 1 | 2, ctx: BuildContext): Item[] {
  const inBar = events.filter((event) => event.start < barEnd && event.end > barStart);
  if (inBar.length === 0) {
    if (voiceNumber === 2) return [];
    const whole: CutPiece = { from: barStart, to: barEnd, value: WHOLE_VALUE, tuplet: null };
    return [restItem(whole, barStart, true)];
  }
  const items: Item[] = [];
  let cursor = barStart;
  for (const event of inBar) {
    const from = Math.max(event.start, barStart);
    const to = Math.min(event.end, barEnd);
    if (from > cursor) for (const piece of cutSpan(cursor, from, barStart, true, ctx)) items.push(restItem(piece, barStart, false));
    const pieces = cutSpan(from, to, barStart, false, ctx);
    pieces.forEach((piece, i) => {
      const isFirst = i === 0;
      const isLast = i === pieces.length - 1;
      const heads = headsFor(event, ctx, {
        tiesToNext: !isLast || event.end > barEnd,
        tiedFromPrevious: !isFirst || event.start < barStart,
      });
      items.push(chordItem(piece, barStart, heads));
    });
    cursor = to;
  }
  if (cursor < barEnd) for (const piece of cutSpan(cursor, barEnd, barStart, true, ctx)) items.push(restItem(piece, barStart, false));
  return items;
}
