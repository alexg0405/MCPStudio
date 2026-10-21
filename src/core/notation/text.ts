/**
 * The compact text form of a score, for reading and writing music with words: "| C4q E4q G4h | [C4 E4 G4]w |".
 *
 *  - A note is its name (C4, F#3, Bb5; middle C is C4) and a value: w whole, h half, q quarter, e eighth, s sixteenth,
 *    t thirty-second; "." dots it, "3" makes it a triplet, "~" ties it to the next note of the same pitch ("C4h~ C4q").
 *  - A chord is its notes in brackets with one value: "[C4 E4 G4]h". A rest is r and a value: "rq". "R" is a whole-bar rest.
 *  - Drums use names with a colon: "kick:q", "[kick hat]:e" (kick snare hat open-hat clap rim pedal-hat tom-low tom-mid
 *    tom-high crash ride ride-bell perc).
 *  - Bars sit between "|". Two voices in one bar are separated by "&". Anything before the first "|" is a header:
 *    "4/4 key=Am tempo=120".
 */
import { DRUM_NAMES, drumName } from './drums';
import { LETTER_VALUES, ticksOfValue, VALUE_LETTERS } from './durations';
import { keyOfSpelling, spellingName } from './spelling';
import type { ChordItem, Item, NoteValue, Score, Step } from './types';

/** Names of the seven letters and the pitch class of each, for reading note names. */
const LETTER_STEPS: Readonly<Record<string, Step>> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/** The value written as text: "q", "e.", "e3" for a triplet eighth. */
function durationText(value: NoteValue, isTriplet: boolean): string {
  return `${VALUE_LETTERS[value.base]}${value.dots ? '.' : ''}${isTriplet ? '3' : ''}`;
}

function chordText(chord: ChordItem, isPercussion: boolean): string {
  const names = chord.heads.map((head) => (isPercussion ? drumName(head.key) : spellingName(head.spelling)));
  const duration = durationText(chord.value, chord.tuplet !== null);
  const ties = chord.heads.map((head) => head.tiesToNext);
  const allTie = ties.every(Boolean);
  const anyTie = ties.some(Boolean);
  const separator = isPercussion ? ':' : '';
  if (names.length === 1) return `${names[0]}${separator}${duration}${allTie ? '~' : ''}`;
  const inside = names.map((name, i) => (anyTie && !allTie && ties[i] ? `${name}~` : name)).join(' ');
  return `[${inside}]${separator}${duration}${allTie ? '~' : ''}`;
}

function itemText(item: Item, isPercussion: boolean): string {
  if (item.kind === 'rest') return item.isWholeBar ? 'R' : `r${durationText(item.value, item.tuplet !== null)}`;
  return chordText(item, isPercussion);
}

/** One bar as text: its voices (every staff's voices in order) joined by " & ". */
export function barText(score: Score, barIndex: number): string {
  const measure = score.measures[barIndex];
  if (!measure) return '';
  const voices: string[] = [];
  for (const staff of measure.staves) {
    for (const voice of staff.voices) voices.push(voice.items.map((item) => itemText(item, score.isPercussion)).join(' '));
  }
  return voices.join(' & ');
}

/** The header line: "4/4 key=G major tempo=120". */
export function headerText(score: Score): string {
  return `${score.timeSig.num}/${score.timeSig.den} key=${score.keySignature.name.replace(' ', '-')} tempo=${Math.round(score.bpm)}`;
}

/** The score as one line per `barsPerLine` bars; the header is the first line. */
export function formatNotation(score: Score, options: { barsPerLine?: number; header?: boolean; fromBar?: number; toBar?: number } = {}): string {
  const perLine = Math.max(1, options.barsPerLine ?? 4);
  const first = Math.max(0, (options.fromBar ?? 1) - 1);
  const last = Math.min(score.measures.length, options.toBar ?? score.measures.length);
  const lines: string[] = [];
  if (options.header !== false) lines.push(headerText(score));
  for (let from = first; from < last; from += perLine) {
    const bars: string[] = [];
    for (let bar = from; bar < Math.min(last, from + perLine); bar++) bars.push(barText(score, bar));
    lines.push(`| ${bars.join(' | ')} |`);
  }
  return lines.join('\n');
}

/** A note read from text, in ticks from the start. */
export interface ParsedNote {
  tick: number;
  length: number;
  key: number;
  /** True when the key came from a drum name. */
  isDrum: boolean;
}

/** What `parseNotation` read. */
export interface ParsedNotation {
  notes: ParsedNote[];
  /** How many bars the text has. */
  bars: number;
  /** Header values that were given. */
  header: { timeSig?: { num: number; den: number }; bpm?: number; keyText?: string };
  /** Tokens that were not understood. */
  errors: string[];
  /** Bars whose voices do not add up to the bar length. */
  warnings: string[];
}

const PITCH = /^([A-G])(##|#|bb|b)?(-?\d+)$/;
const DURATION = /^([whqestx])(\.?)(3?)$/;

/** The key of a note name ("C#4"), or null. */
export function parsePitchName(name: string): number | null {
  const match = PITCH.exec(name);
  if (!match) return null;
  const alter = match[2] === '#' ? 1 : match[2] === '##' ? 2 : match[2] === 'b' ? -1 : match[2] === 'bb' ? -2 : 0;
  const key = keyOfSpelling({ step: LETTER_STEPS[match[1] as string] as Step, alter, octave: Number(match[3]) });
  return key >= 0 && key <= 127 ? key : null;
}

/** The length in ticks of a value written as text ("q", "e.", "e3"), or null. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (!match) return null;
  const base = LETTER_VALUES[match[1] as string] as NoteValue['base'];
  const ticks = ticksOfValue({ base, dots: match[2] ? 1 : 0 });
  return match[3] ? Math.round((ticks * 2) / 3) : ticks;
}

/** The pieces of a bar: bracketed chords stay whole. */
function tokensOf(text: string): string[] {
  return text.match(/\[[^\]]*\][^\s]*|\S+/g) ?? [];
}

interface Head {
  key: number;
  isDrum: boolean;
  tiesOn: boolean;
}

function parseHead(text: string): Head | null {
  const tiesOn = text.endsWith('~');
  const name = tiesOn ? text.slice(0, -1) : text;
  const pitch = parsePitchName(name);
  if (pitch !== null) return { key: pitch, isDrum: false, tiesOn };
  const drum = DRUM_NAMES[name];
  return drum === undefined ? null : { key: drum, isDrum: true, tiesOn };
}

/** Splits a token into its heads, its value text and whether the whole token ties. */
function splitToken(token: string): { heads: string[]; duration: string; tiesAll: boolean } | null {
  let rest = token;
  const tiesAll = rest.endsWith('~');
  if (tiesAll) rest = rest.slice(0, -1);
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return null;
    return { heads: rest.slice(1, close).trim().split(/\s+/), duration: rest.slice(close + 1).replace(/^:/, ''), tiesAll };
  }
  const colon = rest.indexOf(':');
  if (colon >= 0) return { heads: [rest.slice(0, colon)], duration: rest.slice(colon + 1), tiesAll };
  const match = /^(.*?)([whqestx]\.?3?)$/.exec(rest);
  if (!match) return null;
  return { heads: [match[1] as string], duration: match[2] as string, tiesAll };
}

/** Reads the header words before the first bar line. */
function parseHeader(text: string): ParsedNotation['header'] {
  const header: ParsedNotation['header'] = {};
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const signature = /^(\d+)\/(\d+)$/.exec(word);
    if (signature) header.timeSig = { num: Number(signature[1]), den: Number(signature[2]) };
    else if (word.startsWith('tempo=')) header.bpm = Number(word.slice(6));
    else if (word.startsWith('key=')) header.keyText = word.slice(4);
  }
  return header;
}

/**
 * Reads the compact text. `timeSig` is the meter to measure bars by when the header gives none. Notes that are tied
 * to a note of the same pitch that starts where they end are joined into one.
 */
export function parseNotation(text: string, timeSig: { num: number; den: number }): ParsedNotation {
  const firstBar = text.indexOf('|');
  const header = parseHeader(firstBar < 0 ? '' : text.slice(0, firstBar));
  const meter = header.timeSig ?? timeSig;
  const barTicks = (3840 / meter.den) * meter.num;
  const result: ParsedNotation = { notes: [], bars: 0, header, errors: [], warnings: [] };
  const bars = (firstBar < 0 ? text : text.slice(firstBar)).split('|').map((part) => part.trim()).filter((part) => part.length > 0);
  // Ties run across bar lines, so each voice (the first, the second...) keeps its open ties from bar to bar.
  const openTies: Array<Map<number, ParsedNote>> = [];
  bars.forEach((bar, barIndex) => {
    result.bars++;
    bar.split('&').forEach((voice, voiceIndex) => {
      openTies[voiceIndex] ??= new Map();
      readVoice(voice, barIndex, barTicks, result, openTies[voiceIndex] as Map<number, ParsedNote>);
    });
  });
  return result;
}

function readVoice(voice: string, barIndex: number, barTicks: number, result: ParsedNotation, open: Map<number, ParsedNote>): void {
  const barStart = barIndex * barTicks;
  let cursor = barStart;
  for (const token of tokensOf(voice.trim())) {
    if (token === 'R') {
      cursor += barTicks;
      continue;
    }
    if (token.startsWith('r') && DURATION.test(token.slice(1).replace(/~$/, ''))) {
      cursor += parseDuration(token.slice(1).replace(/~$/, '')) as number;
      continue;
    }
    const parts = splitToken(token);
    const length = parts ? parseDuration(parts.duration) : null;
    const heads = parts ? parts.heads.map(parseHead) : [];
    if (!parts || length === null || heads.length === 0 || heads.some((head) => head === null)) {
      result.errors.push(`"${token}" is not a note, a chord or a rest (write a note like C4q, a chord like [C4 E4]h, a rest like rq)`);
      continue;
    }
    for (const head of heads as Head[]) addHead(result, open, head, cursor, length, parts.tiesAll || head.tiesOn);
    cursor += length;
  }
  const used = cursor - barStart;
  if (used !== barTicks && cursor !== barStart) {
    result.warnings.push(`bar ${barIndex + 1} holds ${(used / 960).toFixed(2).replace(/\.?0+$/, '')} beats but the meter has ${barTicks / 960}`);
  }
}

/** Adds one head, joining it to a tied note that ends where it starts. */
function addHead(result: ParsedNotation, open: Map<number, ParsedNote>, head: Head, tick: number, length: number, ties: boolean): void {
  const joined = open.get(head.key);
  if (joined && joined.tick + joined.length === tick) {
    joined.length += length;
    if (!ties) open.delete(head.key);
    return;
  }
  const note: ParsedNote = { tick, length, key: head.key, isDrum: head.isDrum };
  result.notes.push(note);
  if (ties) open.set(head.key, note);
  else open.delete(head.key);
}
