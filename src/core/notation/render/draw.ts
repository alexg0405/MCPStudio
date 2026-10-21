/**
 * Draws one system of a laid-out score as an SVG string: the staves with their clefs, key and time signatures, the bars
 * with their notes, bar lines and numbers, and the chord symbols, dynamics and lyrics around them. The same layout always
 * gives the same text (no random ids, numbers rounded), so the picture can be compared in tests.
 */
import type { ClefKind, ChordItem, Score } from '../types';
import { drawVoice, yOfPosition, type StaffPlace } from './draw-voice';
import { accidental, bassClef, brace, num, percussionClef, place, trebleClef } from './glyphs';
import { MARGIN, SPACE, xInMeasure, type MeasureLayout, type SystemLayout } from './layout';

/** Positions (diatonic, E4 = 30) of the sharps and flats of a key signature, in the order they are added, per clef. */
const SHARP_POSITIONS: Record<'treble' | 'bass', readonly number[]> = { treble: [38, 35, 39, 36, 33, 37, 34], bass: [24, 21, 25, 22, 19, 23, 20] };
const FLAT_POSITIONS: Record<'treble' | 'bass', readonly number[]> = { treble: [34, 37, 33, 36, 32, 35, 31], bass: [20, 23, 19, 22, 18, 21, 17] };

const LYRIC_FONT = 1.7 * SPACE;
const CHORD_FONT = 1.8 * SPACE;
const DYNAMIC_FONT = 2.0 * SPACE;
const NUMBER_FONT = 1.3 * SPACE;
const TIME_FONT = 2.9 * SPACE;

/** Options for drawing. */
export interface DrawOptions {
  /** Pixels per layout pixel: 1 draws at the size the layout was made for. */
  zoom: number;
}

function staffLines(system: SystemLayout, staff: StaffPlace): string {
  const x1 = MARGIN;
  const x2 = system.width - MARGIN;
  let d = '';
  for (let line = 0; line < 5; line++) d += `M${num(x1)} ${num(staff.top + line * SPACE)}H${num(x2)}`;
  return `<path class="ag-staff" d="${d}" fill="none" stroke="currentColor" stroke-width="0.9"/>`;
}

function clefShape(clef: ClefKind, x: number, top: number): string {
  if (clef === 'treble') return place(x, top + 3 * SPACE, SPACE, trebleClef());
  if (clef === 'bass') return place(x, top + SPACE, SPACE, bassClef());
  return place(x, top + 2 * SPACE, SPACE, percussionClef());
}

function keySignature(fifths: number, clef: ClefKind, x: number, staff: StaffPlace): string {
  if (fifths === 0 || clef === 'percussion') return '';
  const positions = (fifths > 0 ? SHARP_POSITIONS : FLAT_POSITIONS)[clef];
  const sign = fifths > 0 ? 'sharp' : 'flat';
  const out: string[] = [];
  for (let i = 0; i < Math.abs(fifths); i++) out.push(place(x + i * 1.05 * SPACE, yOfPosition(staff, positions[i] as number), SPACE, accidental(sign)));
  return out.join('');
}

function timeSignature(score: Score, x: number, top: number): string {
  const digits = (value: number, baseline: number): string =>
    `<text x="${num(x)}" y="${num(baseline)}" font-size="${num(TIME_FONT)}" font-weight="bold" font-family="serif" text-anchor="middle" fill="currentColor">${value}</text>`;
  return digits(score.timeSig.num, top + 2 * SPACE) + digits(score.timeSig.den, top + 4 * SPACE);
}

function barline(x: number, top: number, bottom: number, isFinal: boolean): string {
  const thin = `<path d="M${num(x)} ${num(top)}V${num(bottom)}" stroke="currentColor" stroke-width="1" fill="none"/>`;
  if (!isFinal) return thin;
  return `<path d="M${num(x - 3)} ${num(top)}V${num(bottom)}" stroke="currentColor" stroke-width="1" fill="none"/><path d="M${num(x - 0.5)} ${num(top)}V${num(bottom)}" stroke="currentColor" stroke-width="3" fill="none"/>`;
}

/** The clefs, signatures, brace and the line that joins the staves at the start of a system. */
function systemHeader(score: Score, system: SystemLayout, staves: readonly StaffPlace[]): string {
  const top = (staves[0] as StaffPlace).top;
  const bottom = (staves[staves.length - 1] as StaffPlace).top + 4 * SPACE;
  const isGrand = staves.length > 1;
  const out: string[] = [barline(MARGIN, top, bottom, false)];
  if (isGrand) out.push(place(MARGIN - 1.05 * SPACE, top, SPACE, brace((bottom - top) / SPACE)));
  const clefX = MARGIN + (isGrand ? 1.9 : 0.9) * SPACE;
  const keyX = clefX + 2.2 * SPACE;
  const keyWidth = Math.abs(score.keySignature.fifths) * 1.05 * SPACE;
  staves.forEach((staff) => {
    out.push(clefShape(staff.clef, clefX, staff.top));
    out.push(keySignature(score.keySignature.fifths, staff.clef, keyX, staff));
    if (system.hasTimeSignature) out.push(timeSignature(score, keyX + keyWidth + (keyWidth > 0 ? 1.2 : 0.6) * SPACE, staff.top));
  });
  return out.join('');
}

/** Chord symbols above the first staff. */
function chordSymbols(layout: MeasureLayout, y: number): string {
  return layout.measure.chordSymbols
    .map((symbol) => {
      const x = xInMeasure(layout, symbol.tick) - 0.7 * SPACE;
      return `<text class="ag-chord-symbol" x="${num(x)}" y="${num(y)}" font-size="${num(CHORD_FONT)}" font-weight="600" font-family="sans-serif" fill="currentColor">${escapeText(symbol.text)}</text>`;
    })
    .join('');
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Dynamics under a staff, for the chords of voice 1. */
function dynamics(layout: MeasureLayout, staffIndex: number, y: number): string {
  const voice = layout.measure.staves[staffIndex]?.voices[0];
  if (!voice) return '';
  return voice.items
    .filter((item): item is ChordItem => item.kind === 'chord' && item.dynamic !== null)
    .map((item) => `<text class="ag-dynamic" x="${num(xInMeasure(layout, item.tick))}" y="${num(y)}" font-size="${num(DYNAMIC_FONT)}" font-style="italic" font-weight="bold" font-family="serif" text-anchor="middle" fill="currentColor">${item.dynamic}</text>`)
    .join('');
}

/** Lyric syllables under the first staff, with a hyphen where a word goes on. */
function lyrics(layout: MeasureLayout, y: number): string {
  const voice = layout.measure.staves[0]?.voices[0];
  if (!voice) return '';
  const withWords = voice.items.filter((item): item is ChordItem => item.kind === 'chord' && item.lyric !== null);
  const out: string[] = [];
  withWords.forEach((item, i) => {
    const x = xInMeasure(layout, item.tick);
    out.push(`<text class="ag-lyric" x="${num(x)}" y="${num(y)}" font-size="${num(LYRIC_FONT)}" font-family="sans-serif" text-anchor="middle" fill="currentColor">${escapeText(item.lyric?.text ?? '')}</text>`);
    if (!item.lyric?.continues) return;
    const next = withWords[i + 1];
    const nextX = next ? xInMeasure(layout, next.tick) : layout.left + layout.width;
    out.push(`<text x="${num((x + nextX) / 2)}" y="${num(y)}" font-size="${num(LYRIC_FONT)}" font-family="sans-serif" text-anchor="middle" fill="currentColor">-</text>`);
  });
  return out.join('');
}

function measureShapes(score: Score, system: SystemLayout, layout: MeasureLayout, staves: readonly StaffPlace[]): string {
  const out: string[] = [];
  const top = (staves[0] as StaffPlace).top;
  const bottom = (staves[staves.length - 1] as StaffPlace).top + 4 * SPACE;
  layout.measure.staves.forEach((staffMeasure, staffIndex) => {
    const hasTwoVoices = staffMeasure.voices.length > 1;
    for (const voice of staffMeasure.voices) {
      out.push(drawVoice({ measure: layout.measure, layout, staff: staves[staffIndex] as StaffPlace, voice, hasTwoVoices }));
    }
    out.push(dynamics(layout, staffIndex, system.dynamicY[staffIndex] as number));
  });
  out.push(chordSymbols(layout, system.chordY));
  if (score.hasLyrics) out.push(lyrics(layout, system.lyricY));
  const isFinal = layout.measure.index === score.measures.length - 1;
  out.push(barline(layout.left + layout.width, top, bottom, isFinal));
  if (layout.measure.index > 0 && layout === system.measures[0]) {
    out.push(`<text class="ag-bar-number" x="${num(layout.left + 0.3 * SPACE)}" y="${num(top - 1.6 * SPACE)}" font-size="${num(NUMBER_FONT)}" font-style="italic" font-family="sans-serif" fill="currentColor">${layout.measure.index + 1}</text>`);
  }
  return `<g class="ag-bar" data-bar="${layout.measure.index}">${out.join('')}</g>`;
}

/** The SVG of one system. */
export function renderSystem(score: Score, system: SystemLayout, options: DrawOptions): string {
  const staves: StaffPlace[] = score.clefs.map((clef, i) => ({ top: system.staffTops[i] as number, clef }));
  const width = system.width;
  const height = system.height;
  const body = [
    ...staves.map((staff) => staffLines(system, staff)),
    systemHeader(score, system, staves),
    ...system.measures.map((layout) => measureShapes(score, system, layout, staves)),
    `<rect class="ag-cursor" x="0" y="0" width="0" height="0" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 3" rx="3" visibility="hidden"/>`,
  ].join('');
  return `<svg class="ag-system" data-system="${system.index}" xmlns="http://www.w3.org/2000/svg" width="${num(width * options.zoom)}" height="${num(height * options.zoom)}" viewBox="0 0 ${num(width)} ${num(height)}" aria-hidden="true" focusable="false">${body}</svg>`;
}
