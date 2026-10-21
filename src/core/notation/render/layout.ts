/**
 * Places a score on the page: widths of bars from the notes inside them (a longer note takes more room, accidentals,
 * dots and lyrics push their neighbours aside), bars into systems that fill the page width, and the staves of a system one
 * under the other. Pure arithmetic in pixels: `draw.ts` turns the result into SVG, the window reads it for hit-testing,
 * following the playhead and the keyboard cursor.
 */
import type { Tick } from '../../model/types';
import type { ChordItem, ClefKind, Item, Measure, Score } from '../types';

/** Pixels per staff space (the gap between two lines): the size every other number is a multiple of. */
export const SPACE = 8;

/** Where notes sit across a bar: the pixel x of the note centre at each start tick, measured from the bar's left line. */
export interface Column {
  tick: Tick;
  x: number;
}

/** One bar placed in a system. */
export interface MeasureLayout {
  measure: Measure;
  /** Left bar line, in pixels from the system's left edge. */
  left: number;
  width: number;
  columns: Column[];
}

/** One line of music. */
export interface SystemLayout {
  index: number;
  width: number;
  height: number;
  /** y of the top line of each staff. */
  staffTops: number[];
  measures: MeasureLayout[];
  /** Pixels taken by the clef, key signature and time signature before the first bar. */
  headerWidth: number;
  /** y where chord symbols are written. */
  chordY: number;
  /** y where dynamics are written, per staff. */
  dynamicY: number[];
  /** y where lyrics are written. */
  lyricY: number;
  hasTimeSignature: boolean;
}

/** The whole score placed. */
export interface SheetLayout {
  systems: SystemLayout[];
  /** The widest system. */
  width: number;
  clefs: ClefKind[];
}

/** What the layout needs besides the score. */
export interface LayoutOptions {
  /** Pixels available across a page. */
  width: number;
}

/** Space left of the staves (for the brace of a piano part) and right of them. */
export const MARGIN = 1.6 * SPACE;
const LEFT_PADDING = 1.2 * SPACE;
const MIN_AFTER_NOTE = 1.0 * SPACE;
const HEAD_WIDTH = 1.3 * SPACE;
const ACCIDENTAL_COLUMN = 1.15 * SPACE;
const STAFF_HEIGHT = 4 * SPACE;
const ONE_STAFF_GAP = 9 * SPACE;
const LYRIC_FONT = 1.7 * SPACE;
const CHORD_FONT = 1.8 * SPACE;
const SYSTEM_SPACING = 3 * SPACE;
/** A silence or a note longer than a half note does not take more room than a half note. */
const LONGEST_SPACED = 1920;
/** The x of a note is its centre; whole-bar rests are centred in the bar instead. */
const EMPTY_BAR_WIDTH = 12 * SPACE;

/** The room a note value asks for, by the time to the next note: logarithmic, as engravers space music. */
function spaceFor(deltaTicks: number): number {
  return SPACE * (1.5 + 1.7 * Math.log2(Math.min(deltaTicks, LONGEST_SPACED) / 120 + 1));
}

/** Rough pixel width of text at a size (system sans-serif is about half as wide as it is tall). */
export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}

/** Accidental columns a chord needs to the left of its heads: signs a sixth or more apart share a column. */
export function accidentalColumns(chord: ChordItem): number[] {
  const columns: number[] = new Array<number>(chord.heads.length).fill(-1);
  const taken: Array<number[]> = [];
  for (let i = chord.heads.length - 1; i >= 0; i--) {
    const head = chord.heads[i] as ChordItem['heads'][number];
    if (!head.accidental) continue;
    let column = 0;
    while ((taken[column] ?? []).some((position) => Math.abs(position - head.position) < 6)) column++;
    (taken[column] ??= []).push(head.position);
    columns[i] = column;
  }
  return columns;
}

function leftRoom(chord: ChordItem): number {
  const columns = Math.max(-1, ...accidentalColumns(chord)) + 1;
  const displacedLeft = chord.stem === 'down' && chord.heads.some((head) => head.isDisplaced) ? HEAD_WIDTH : 0;
  return (columns > 0 ? columns * ACCIDENTAL_COLUMN + 0.3 * SPACE : 0) + displacedLeft;
}

function rightRoom(chord: ChordItem): number {
  const displacedRight = chord.stem !== 'down' && chord.heads.some((head) => head.isDisplaced) ? HEAD_WIDTH : 0;
  return displacedRight + (chord.value.dots > 0 ? 1.0 * SPACE : 0);
}

/** The items that start at a tick, over every staff and voice. */
function itemsOf(measure: Measure): Array<{ item: Item }> {
  const out: Array<{ item: Item }> = [];
  for (const staff of measure.staves) for (const voice of staff.voices) for (const item of voice.items) out.push({ item });
  return out;
}

/** The columns of a bar and its natural width (before the system stretches it). */
export function measureColumns(measure: Measure): { columns: Column[]; width: number } {
  const entries = itemsOf(measure);
  const ticks = [...new Set(entries.map((entry) => entry.item.tick))].sort((a, b) => a - b);
  if (entries.every((entry) => entry.item.kind === 'rest' && entry.item.isWholeBar)) return { columns: [{ tick: 0, x: EMPTY_BAR_WIDTH / 2 }], width: EMPTY_BAR_WIDTH };
  const left = new Map<Tick, number>();
  const right = new Map<Tick, number>();
  const label = new Map<Tick, number>();
  for (const { item } of entries) {
    if (item.kind !== 'chord') continue;
    left.set(item.tick, Math.max(left.get(item.tick) ?? 0, leftRoom(item)));
    right.set(item.tick, Math.max(right.get(item.tick) ?? 0, rightRoom(item)));
    if (item.lyric) label.set(item.tick, Math.max(label.get(item.tick) ?? 0, textWidth(item.lyric.text, LYRIC_FONT) + (item.lyric.continues ? 0.8 * SPACE : 0)));
  }
  for (const symbol of measure.chordSymbols) {
    const at = ticks.filter((tick) => tick <= symbol.tick).pop() ?? ticks[0] ?? 0;
    label.set(at, Math.max(label.get(at) ?? 0, textWidth(symbol.text, CHORD_FONT) + 0.5 * SPACE));
  }
  const columns: Column[] = [];
  let x = LEFT_PADDING + (left.get(ticks[0] as Tick) ?? 0);
  ticks.forEach((tick, i) => {
    columns.push({ tick, x });
    const nextTick = ticks[i + 1] ?? measure.ticks;
    const wanted = spaceFor(nextTick - tick);
    const clearance = (right.get(tick) ?? 0) + (left.get(nextTick) ?? 0) + MIN_AFTER_NOTE;
    const labelRoom = (label.get(tick) ?? 0) / 2 + (label.get(nextTick) ?? 0) / 2 + 0.4 * SPACE;
    x += Math.max(wanted, clearance, labelRoom);
  });
  return { columns, width: x };
}

/** Clef, key signature and (on the first system) time signature widths. */
function headerWidthOf(score: Score, isFirst: boolean): number {
  const signs = score.isPercussion ? 0 : Math.abs(score.keySignature.fifths);
  const timeWidth = isFirst ? 3 * SPACE : 0;
  return 3.8 * SPACE + (signs > 0 ? signs * 1.05 * SPACE + 0.8 * SPACE : 0) + timeWidth;
}

/** The heights of one system for this score. */
function staffTopsOf(score: Score, hasChords: boolean): { tops: number[]; height: number; chordY: number; lyricY: number; dynamicY: number[] } {
  const chordBand = hasChords ? 3 * SPACE : 0;
  const first = chordBand + 4.5 * SPACE;
  const hasDynamics = score.measures.some((measure) => measure.staves.some((staff) => staff.voices.some((voice) => voice.items.some((item) => item.kind === 'chord' && item.dynamic))));
  const extraBelow = (hasDynamics ? 2.2 : 0) * SPACE + (score.hasLyrics ? 3 : 0) * SPACE;
  const tops = [first];
  for (let i = 1; i < score.clefs.length; i++) tops.push((tops[i - 1] as number) + STAFF_HEIGHT + ONE_STAFF_GAP + (i === 1 ? extraBelow : 0));
  const lastBottom = (tops[tops.length - 1] as number) + STAFF_HEIGHT;
  const bottomRoom = 4.5 * SPACE + (score.clefs.length === 1 ? extraBelow : hasDynamics ? 2.2 * SPACE : 0);
  const dynamicY = tops.map((top) => top + STAFF_HEIGHT + 3.4 * SPACE);
  return {
    tops,
    height: lastBottom + bottomRoom,
    chordY: chordBand - 0.6 * SPACE,
    lyricY: (tops[0] as number) + STAFF_HEIGHT + (hasDynamics ? 5.6 : 3.6) * SPACE,
    dynamicY,
  };
}

/** Lays the score out. */
export function layoutScore(score: Score, options: LayoutOptions): SheetLayout {
  const hasChords = score.measures.some((measure) => measure.chordSymbols.length > 0);
  const heights = staffTopsOf(score, hasChords);
  const natural = score.measures.map((measure) => measureColumns(measure));
  const systems: SystemLayout[] = [];
  let next = 0;
  while (next < score.measures.length) {
    const index = systems.length;
    const headerWidth = headerWidthOf(score, index === 0);
    const available = options.width - 2 * MARGIN - headerWidth;
    const first = next;
    let used = 0;
    while (next < score.measures.length && (next === first || used + (natural[next] as { width: number }).width <= available)) {
      used += (natural[next] as { width: number }).width;
      next++;
    }
    const isLast = next >= score.measures.length;
    const stretch = isLast && used < 0.6 * available ? 1 : Math.max(1, available / used);
    const measures: MeasureLayout[] = [];
    let left = MARGIN + headerWidth;
    for (let m = first; m < next; m++) {
      const placed = natural[m] as { columns: Column[]; width: number };
      const width = placed.width * stretch;
      measures.push({ measure: score.measures[m] as Measure, left, width, columns: placed.columns.map((column) => ({ tick: column.tick, x: column.x * stretch })) });
      left += width;
    }
    systems.push({
      index,
      width: left + MARGIN,
      height: heights.height + SYSTEM_SPACING,
      staffTops: heights.tops,
      measures,
      headerWidth,
      chordY: heights.chordY,
      dynamicY: heights.dynamicY,
      lyricY: heights.lyricY,
      hasTimeSignature: index === 0,
    });
  }
  return { systems, width: Math.max(...systems.map((system) => system.width), 0), clefs: score.clefs };
}

/** The pixel x of a pattern tick inside a placed bar (between columns it is interpolated). */
export function xInMeasure(layout: MeasureLayout, tickInBar: Tick): number {
  const columns = layout.columns;
  const last = columns[columns.length - 1] as Column;
  if (tickInBar <= (columns[0] as Column).tick) return layout.left + (columns[0] as Column).x;
  for (let i = 0; i + 1 < columns.length; i++) {
    const a = columns[i] as Column;
    const b = columns[i + 1] as Column;
    if (tickInBar < b.tick) return layout.left + a.x + ((b.x - a.x) * (tickInBar - a.tick)) / (b.tick - a.tick);
  }
  const end = layout.measure.ticks;
  const room = layout.width - last.x;
  return layout.left + last.x + Math.min(room, room * ((tickInBar - last.tick) / Math.max(1, end - last.tick)));
}

/** Where a pattern tick is drawn: the system and the pixel x in it, or null past the end of the score. */
export function locateTick(layout: SheetLayout, barTicks: Tick, tick: Tick): { system: SystemLayout; x: number } | null {
  const barIndex = Math.floor(tick / barTicks);
  for (const system of layout.systems) {
    const measure = system.measures.find((candidate) => candidate.measure.index === barIndex);
    if (measure) return { system, x: xInMeasure(measure, tick - measure.measure.startTick) };
  }
  return null;
}
