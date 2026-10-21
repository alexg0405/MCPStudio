/**
 * Draws one voice of one staff in one bar as SVG: noteheads, ledger lines, accidentals, dots, stems, flags, beams, ties,
 * tuplet marks and rests. Chords are laid out first (where each head, stem and beam goes) and written afterwards, because
 * a beam moves the stems under it.
 *
 * Every chord and rest is a group with `data-t0` and `data-t1` (the pattern ticks it sounds between, for following the
 * playhead); every notehead is a group with `data-note` (the note's id, for clicking and for showing the selection).
 */
import type { ChordItem, ClefKind, Item, Measure, RestItem, Voice } from '../types';
import { accidental, dot, flag, HEAD_HALF_WIDTH, notehead, num, openMark, place, restShape } from './glyphs';
import { accidentalColumns, SPACE, xInMeasure, type MeasureLayout } from './layout';

/** The place on one staff of one system. */
export interface StaffPlace {
  top: number;
  clef: ClefKind;
}

const HEAD_WIDTH = 2 * HEAD_HALF_WIDTH * SPACE;
const STEM_LENGTH = 3.5 * SPACE;
const STEM_WIDTH = 1;
/** A beamed stem is never shorter than this. */
const SHORTEST_BEAMED_STEM = 2.75 * SPACE;
const BEAM_THICKNESS = 0.5 * SPACE;
const BEAM_GAP = 0.8 * SPACE;
const MAX_BEAM_SLANT = SPACE;
const STUB_LENGTH = 1.0 * SPACE;
const ACCIDENTAL_COLUMN = 1.15 * SPACE;

/** The diatonic position of the top line: F5 for a treble or percussion staff, A3 for a bass staff. */
const topPositionOf = (clef: ClefKind): number => (clef === 'bass' ? 26 : 38);

/** y of a diatonic position on a staff (each position is half a staff space). */
export function yOfPosition(staff: StaffPlace, position: number): number {
  return staff.top + (topPositionOf(staff.clef) - position) * 0.5 * SPACE;
}

/** Where a chord's parts are. */
interface ChordGeometry {
  item: ChordItem;
  x: number;
  headXs: number[];
  headYs: number[];
  direction: 'up' | 'down' | 'none';
  stemX: number;
  /** y of the end of the stem away from the heads. */
  tip: number;
  /** y of the end of the stem at the heads. */
  root: number;
}

function geometryOf(item: ChordItem, x: number, staff: StaffPlace): ChordGeometry {
  const headYs = item.heads.map((head) => yOfPosition(staff, head.position));
  const direction = item.stem;
  const headXs = item.heads.map((head) => (head.isDisplaced ? x + (direction === 'down' ? -HEAD_WIDTH : HEAD_WIDTH) : x));
  const highest = Math.min(...headYs);
  const lowest = Math.max(...headYs);
  const middle = staff.top + 2 * SPACE;
  const stemX = direction === 'down' ? x - HEAD_HALF_WIDTH * SPACE * 0.95 : x + HEAD_HALF_WIDTH * SPACE * 0.95;
  if (direction === 'up') return { item, x, headXs, headYs, direction, stemX, tip: Math.min(highest - STEM_LENGTH, middle), root: lowest };
  if (direction === 'down') return { item, x, headXs, headYs, direction, stemX, tip: Math.max(lowest + STEM_LENGTH, middle), root: highest };
  return { item, x, headXs, headYs, direction, stemX, tip: highest, root: highest };
}

/** A beam line through the stem tips of a group, with the slant limited and every stem kept long enough. */
interface BeamLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function beamLineOf(group: readonly ChordGeometry[]): BeamLine {
  const first = group[0] as ChordGeometry;
  const last = group[group.length - 1] as ChordGeometry;
  const slant = Math.max(-MAX_BEAM_SLANT, Math.min(MAX_BEAM_SLANT, last.tip - first.tip));
  const line: BeamLine = { x1: first.stemX, y1: first.tip, x2: last.stemX, y2: first.tip + slant };
  const isUp = first.direction === 'up';
  let shift = 0;
  for (const chord of group) {
    const y = yOnBeam(line, chord.stemX);
    const reach = isUp ? Math.min(...chord.headYs) - SHORTEST_BEAMED_STEM : Math.max(...chord.headYs) + SHORTEST_BEAMED_STEM;
    // Up stems: the beam must be at or above `reach`; down stems: at or below it.
    shift = isUp ? Math.max(shift, y - reach) : Math.min(shift, y - reach);
  }
  line.y1 -= shift;
  line.y2 -= shift;
  return line;
}

function yOnBeam(line: BeamLine, x: number): number {
  return line.x2 === line.x1 ? line.y1 : line.y1 + ((line.y2 - line.y1) * (x - line.x1)) / (line.x2 - line.x1);
}

/** The polygons of a beam group: one run per beam level, and short stubs for a lone note with more flags than its neighbours. */
function beamShapes(group: readonly ChordGeometry[], line: BeamLine): string {
  const isUp = (group[0] as ChordGeometry).direction === 'up';
  const levels = Math.max(...group.map((chord) => chord.item.flags));
  const parts: string[] = [];
  for (let level = 1; level <= levels; level++) {
    const offset = (level - 1) * BEAM_GAP * (isUp ? 1 : -1);
    let start = -1;
    for (let i = 0; i <= group.length; i++) {
      const has = i < group.length && (group[i] as ChordGeometry).item.flags >= level;
      if (has && start < 0) start = i;
      if (!has && start >= 0) {
        parts.push(beamRun(group, line, start, i - 1, offset, isUp));
        start = -1;
      }
    }
  }
  return parts.join('');
}

function beamRun(group: readonly ChordGeometry[], line: BeamLine, from: number, to: number, offset: number, isUp: boolean): string {
  let xa = (group[from] as ChordGeometry).stemX;
  let xb = (group[to] as ChordGeometry).stemX;
  if (from === to) {
    // A note with more flags than its neighbours: a stub towards the side that has a neighbour.
    if (from > 0) xa -= STUB_LENGTH;
    else xb += STUB_LENGTH;
  }
  const ya = yOnBeam(line, xa) + offset;
  const yb = yOnBeam(line, xb) + offset;
  const t = isUp ? BEAM_THICKNESS : -BEAM_THICKNESS;
  return `<path d="M${num(xa)} ${num(ya)}L${num(xb)} ${num(yb)}L${num(xb)} ${num(yb + t)}L${num(xa)} ${num(ya + t)}Z" fill="currentColor"/>`;
}

function ledgerLines(geometry: ChordGeometry, staff: StaffPlace): string {
  const positions = geometry.item.heads.map((head) => head.position);
  const top = topPositionOf(staff.clef);
  const bottom = top - 8;
  const highest = Math.max(...positions);
  const lowest = Math.min(...positions);
  const lines: number[] = [];
  for (let position = top + 2; position <= highest; position += 2) lines.push(position);
  for (let position = bottom - 2; position >= lowest; position -= 2) lines.push(position);
  if (lines.length === 0) return '';
  const hasDisplacedRight = geometry.direction !== 'down' && geometry.item.heads.some((head) => head.isDisplaced);
  const left = geometry.x - 1.05 * SPACE;
  const right = geometry.x + 1.05 * SPACE + (hasDisplacedRight ? HEAD_WIDTH : 0);
  const d = lines.map((position) => `M${num(left)} ${num(yOfPosition(staff, position))}H${num(right)}`).join('');
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1"/>`;
}

function headShapes(geometry: ChordGeometry): string {
  const { item } = geometry;
  const parts: string[] = [];
  const columns = accidentalColumns(item);
  const hasDisplacedLeft = geometry.direction === 'down' && item.heads.some((head) => head.isDisplaced);
  const dotX = Math.max(...geometry.headXs) + (HEAD_HALF_WIDTH + 0.55) * SPACE;
  item.heads.forEach((head, i) => {
    const x = geometry.headXs[i] as number;
    const y = geometry.headYs[i] as number;
    const kind = head.shape === 'x' ? 'x' : head.shape === 'diamond' ? 'diamond' : item.value.base === 1 ? 'whole' : item.value.base === 2 ? 'half' : 'filled';
    const hit = `<rect class="ag-hit" x="${num(x - 0.9 * SPACE)}" y="${num(y - 0.75 * SPACE)}" width="${num(1.8 * SPACE)}" height="${num(1.5 * SPACE)}" fill="transparent"/>`;
    const ring = `<path class="ag-ring" d="M${num(x - 1.15 * SPACE)} ${num(y)}A${num(1.15 * SPACE)} ${num(0.9 * SPACE)} 0 1 1 ${num(x + 1.15 * SPACE)} ${num(y)}A${num(1.15 * SPACE)} ${num(0.9 * SPACE)} 0 1 1 ${num(x - 1.15 * SPACE)} ${num(y)}Z" fill="none" stroke="currentColor" stroke-width="2.2"/>`;
    const extras: string[] = [];
    if (head.accidental && columns[i] !== undefined && (columns[i] as number) >= 0) {
      const ax = geometry.x - (HEAD_HALF_WIDTH + 0.55) * SPACE - (columns[i] as number) * ACCIDENTAL_COLUMN - (hasDisplacedLeft ? HEAD_WIDTH : 0);
      const sign = place(ax, y, SPACE, accidental(head.accidental));
      extras.push(head.isCourtesy ? `${sign}${courtesyBrackets(ax, y)}` : sign);
    }
    if (item.value.dots > 0) extras.push(place(dotX, head.position % 2 === 0 ? y - 0.5 * SPACE : y, SPACE, dot()));
    if (head.isOpen) extras.push(place(x, y - 1.15 * SPACE, SPACE, openMark()));
    parts.push(`<g class="ag-head" data-note="${head.noteId}">${hit}<g class="ag-notehead">${place(x, y, SPACE, notehead(kind))}</g>${ring}${extras.join('')}</g>`);
  });
  return parts.join('');
}

/** Round brackets around a courtesy accidental. */
function courtesyBrackets(x: number, y: number): string {
  const left = x - 0.75 * SPACE;
  const right = x + 0.75 * SPACE;
  const h = 1.1 * SPACE;
  return `<path d="M${num(left + 2)} ${num(y - h)}Q${num(left - 1)} ${num(y)} ${num(left + 2)} ${num(y + h)}M${num(right - 2)} ${num(y - h)}Q${num(right + 1)} ${num(y)} ${num(right - 2)} ${num(y + h)}" fill="none" stroke="currentColor" stroke-width="0.8"/>`;
}

/** The stem, and the flags of a note that is not beamed. */
function stemShapes(geometry: ChordGeometry, tipOverride: number | null): string {
  if (geometry.direction === 'none') return '';
  const tip = tipOverride ?? geometry.tip;
  const stem = `<path d="M${num(geometry.stemX)} ${num(geometry.root)}V${num(tip)}" stroke="currentColor" stroke-width="${STEM_WIDTH}" fill="none"/>`;
  if (tipOverride !== null || geometry.item.flags === 0) return stem;
  const flags: string[] = [];
  const isDown = geometry.direction === 'down';
  for (let i = 0; i < geometry.item.flags; i++) {
    const y = tip + (isDown ? -1 : 1) * i * 0.95 * SPACE;
    flags.push(place(geometry.stemX, y, SPACE, flag(isDown)));
  }
  return stem + flags.join('');
}

/** A tie leaving one note and arriving at another, curving away from the stem. */
function tieShape(x1: number, x2: number, y: number, isAbove: boolean): string {
  const dx = Math.max(x2 - x1, 1.2 * SPACE);
  const sign = isAbove ? -1 : 1;
  const y0 = y + sign * 0.65 * SPACE;
  const h = Math.min(1.2 * SPACE, 0.35 * SPACE + dx * 0.1);
  const t = 0.3 * SPACE;
  const c1 = x1 + dx * 0.28;
  const c2 = x1 + dx * 0.72;
  return `<path class="ag-tie" d="M${num(x1)} ${num(y0)}C${num(c1)} ${num(y0 + sign * h)} ${num(c2)} ${num(y0 + sign * h)} ${num(x1 + dx)} ${num(y0)}C${num(c2)} ${num(y0 + sign * (h - t))} ${num(c1)} ${num(y0 + sign * (h - t))} ${num(x1)} ${num(y0)}Z" fill="currentColor"/>`;
}

interface Placed {
  item: Item;
  x: number;
  geometry: ChordGeometry | null;
}

/** What drawing a voice needs besides the bar. */
export interface VoiceContext {
  measure: Measure;
  layout: MeasureLayout;
  staff: StaffPlace;
  voice: Voice;
  hasTwoVoices: boolean;
}

function restX(rest: RestItem, context: VoiceContext): number {
  return rest.isWholeBar ? context.layout.left + context.layout.width / 2 : xInMeasure(context.layout, rest.tick);
}

function restShapes(rest: RestItem, context: VoiceContext): string {
  const x = restX(rest, context);
  const shift = context.hasTwoVoices && !rest.isWholeBar ? (context.voice.number === 1 ? -1 : 1) * SPACE : 0;
  const { top } = context.staff;
  const base = rest.value.base;
  const y = base === 1 ? top + SPACE + shift : base === 2 ? top + 2 * SPACE + shift : top + 2 * SPACE + shift;
  const dots = rest.value.dots > 0 ? place(x + 1.0 * SPACE, top + 1.5 * SPACE + shift, SPACE, dot()) : '';
  const t0 = context.measure.startTick + rest.tick;
  return `<g class="ag-rest" data-t0="${t0}" data-t1="${t0 + rest.ticks}">${place(x, y, SPACE, restShape(base))}${dots}</g>`;
}

/** The number (and bracket) over a triplet, drawn over the notes of the span. */
function tupletShapes(placed: readonly Placed[], staff: StaffPlace, isAbove: boolean): string {
  const byStart = new Map<number, Placed[]>();
  for (const entry of placed) {
    if (!entry.item.tuplet) continue;
    const list = byStart.get(entry.item.tuplet.spanTick) ?? [];
    list.push(entry);
    byStart.set(entry.item.tuplet.spanTick, list);
  }
  const out: string[] = [];
  for (const group of byStart.values()) {
    const xs = group.map((entry) => entry.x);
    const x1 = Math.min(...xs) - 0.4 * SPACE;
    const x2 = Math.max(...xs) + 0.4 * SPACE;
    const geometries = group.map((entry) => entry.geometry).filter((geometry): geometry is ChordGeometry => geometry !== null);
    const beamIds = new Set(geometries.map((geometry) => geometry.item.beamId));
    const isBeamed = geometries.length === group.length && beamIds.size === 1 && !beamIds.has(null);
    const edge = isAbove
      ? Math.min(staff.top - 0.8 * SPACE, ...geometries.map((geometry) => Math.min(geometry.tip, ...geometry.headYs) - 0.9 * SPACE))
      : Math.max(staff.top + 4 * SPACE + 0.8 * SPACE, ...geometries.map((geometry) => Math.max(geometry.tip, ...geometry.headYs) + 0.9 * SPACE));
    const midX = (x1 + x2) / 2;
    const textY = edge + (isAbove ? -0.2 : 1.2) * SPACE;
    out.push(`<text x="${num(midX)}" y="${num(textY)}" font-size="${num(1.6 * SPACE)}" font-style="italic" font-family="serif" text-anchor="middle" fill="currentColor">3</text>`);
    if (!isBeamed) {
      const hook = (isAbove ? 1 : -1) * 0.6 * SPACE;
      const gap = 1.1 * SPACE;
      out.push(
        `<path d="M${num(x1)} ${num(edge + hook)}V${num(edge)}H${num(midX - gap)}M${num(midX + gap)} ${num(edge)}H${num(x2)}V${num(edge + hook)}" fill="none" stroke="currentColor" stroke-width="0.9"/>`,
      );
    }
  }
  return out.join('');
}

/** Ties leaving the notes of a chord, to the next chord of the voice that carries them or to the bar line. */
function tieShapes(placed: readonly Placed[], context: VoiceContext): string {
  const out: string[] = [];
  const isAbove = (geometry: ChordGeometry): boolean => (context.hasTwoVoices ? context.voice.number === 1 : geometry.direction === 'down' || geometry.direction === 'none');
  placed.forEach((entry, index) => {
    const geometry = entry.geometry;
    if (!geometry) return;
    geometry.item.heads.forEach((head, headIndex) => {
      const y = geometry.headYs[headIndex] as number;
      const x = geometry.headXs[headIndex] as number;
      if (head.tiesToNext) {
        const next = placed.slice(index + 1).find((other) => other.geometry?.item.heads.some((candidate) => candidate.key === head.key && candidate.tiedFromPrevious));
        const nextHead = next?.geometry?.item.heads.findIndex((candidate) => candidate.key === head.key && candidate.tiedFromPrevious) ?? -1;
        const x2 = next?.geometry && nextHead >= 0 ? (next.geometry.headXs[nextHead] as number) - 0.8 * SPACE : context.layout.left + context.layout.width - 0.3 * SPACE;
        out.push(tieShape(x + 0.8 * SPACE, x2, y, isAbove(geometry)));
      }
      if (head.tiedFromPrevious && !placed.slice(0, index).some((other) => other.geometry?.item.heads.some((candidate) => candidate.key === head.key && candidate.tiesToNext))) {
        out.push(tieShape(context.layout.left + 0.3 * SPACE, x - 0.8 * SPACE, y, isAbove(geometry)));
      }
    });
  });
  return out.join('');
}

/** Everything drawn for one voice in one bar. */
export function drawVoice(context: VoiceContext): string {
  const { measure, layout, staff, voice } = context;
  const placed: Placed[] = voice.items.map((item) => {
    const x = xInMeasure(layout, item.tick);
    return { item, x, geometry: item.kind === 'chord' ? geometryOf(item, x, staff) : null };
  });
  const beams = new Map<number, ChordGeometry[]>();
  for (const entry of placed) {
    const beamId = entry.geometry?.item.beamId;
    if (entry.geometry && beamId !== null && beamId !== undefined) beams.set(beamId, [...(beams.get(beamId) ?? []), entry.geometry]);
  }
  const lines = new Map<number, BeamLine>();
  for (const [id, group] of beams) lines.set(id, beamLineOf(group));
  const out: string[] = [];
  for (const entry of placed) {
    const geometry = entry.geometry;
    if (!geometry) {
      out.push(restShapes(entry.item as RestItem, context));
      continue;
    }
    const beamLine = geometry.item.beamId === null ? undefined : lines.get(geometry.item.beamId);
    const tip = beamLine ? yOnBeam(beamLine, geometry.stemX) : null;
    const t0 = measure.startTick + geometry.item.tick;
    const band = `<rect class="ag-band" x="${num(geometry.x - 1.3 * SPACE)}" y="${num(staff.top - 1.5 * SPACE)}" width="${num(2.6 * SPACE)}" height="${num(7 * SPACE)}" fill="currentColor"/>`;
    out.push(`<g class="ag-chord" data-t0="${t0}" data-t1="${t0 + geometry.item.ticks}">${band}${ledgerLines(geometry, staff)}${stemShapes(geometry, tip)}${headShapes(geometry)}</g>`);
  }
  for (const [id, group] of beams) out.push(beamShapes(group, lines.get(id) as BeamLine));
  out.push(tieShapes(placed, context));
  const isAbove = placed.some((entry) => entry.geometry?.direction === 'up') || (context.hasTwoVoices && voice.number === 1);
  out.push(tupletShapes(placed, staff, isAbove));
  return out.join('');
}
