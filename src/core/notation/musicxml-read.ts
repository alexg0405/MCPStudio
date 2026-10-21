/**
 * Reads the notes of a MusicXML file (partwise, as AGstudio writes and most notation programs export): pitches or
 * percussion, durations, chords, ties, rests, backups and forwards, in ticks at 960 per quarter note. Dynamics, lyrics and
 * chord symbols are not imported; grace notes are skipped. Only the first part is read unless another is asked for.
 */
import { DRUM_NAMES } from './drums';
import { keyOfSpelling } from './spelling';
import type { Step } from './types';
import { child, childText, childrenNamed, parseXml, XmlError, type XmlNode } from './xml';

const PPQ = 960;
const STEPS: Readonly<Record<string, Step>> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
/** The key a percussion note gets when the file gives no usable drum number. */
const DEFAULT_DRUM_KEY = DRUM_NAMES.perc as number;

/** A note read from a file. */
export interface ImportedNote {
  tick: number;
  length: number;
  key: number;
}

/** What `readMusicXml` found. */
export interface ImportedScore {
  notes: ImportedNote[];
  /** The time signature the file starts in, if it says. */
  timeSig?: { num: number; den: number };
  bpm?: number;
  /** The key signature in sharps (positive) or flats (negative), if the file says. */
  fifths?: number;
  isPercussion: boolean;
  partName: string;
  /** How many parts the file has (only one is read). */
  partCount: number;
  /** How many bars the part has. */
  bars: number;
}

interface ReadState {
  divisions: number;
  barTicks: number;
  barStart: number;
  cursor: number;
  lastStart: number;
  open: Map<number, ImportedNote>;
  drumKeys: Map<string, number>;
  notes: ImportedNote[];
  isPercussion: boolean;
}

/** The drum keys by instrument id, from the part list's `midi-unpitched` numbers (which count from 1). */
function drumKeysOf(partList: XmlNode | undefined, partId: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const scorePart of childrenNamed(partList, 'score-part')) {
    if (scorePart.attributes.id !== partId) continue;
    for (const instrument of childrenNamed(scorePart, 'midi-instrument')) {
      const unpitched = Number(childText(instrument, 'midi-unpitched'));
      if (instrument.attributes.id && Number.isFinite(unpitched) && unpitched >= 1) keys.set(instrument.attributes.id, unpitched - 1);
    }
  }
  return keys;
}

function toTicks(duration: number, divisions: number): number {
  return Math.round((duration * PPQ) / divisions);
}

function readAttributes(attributes: XmlNode, state: ReadState, result: ImportedScore): void {
  const divisions = Number(childText(attributes, 'divisions'));
  if (divisions > 0) state.divisions = divisions;
  const time = child(attributes, 'time');
  if (time) {
    const num = Number(childText(time, 'beats'));
    const den = Number(childText(time, 'beat-type'));
    if (num > 0 && den > 0) {
      result.timeSig ??= { num, den };
      state.barTicks = (num * PPQ * 4) / den;
    }
  }
  const fifths = child(child(attributes, 'key'), 'fifths');
  if (fifths && result.fifths === undefined) result.fifths = Number(fifths.text) || 0;
  if (childrenNamed(attributes, 'clef').some((clef) => childText(clef, 'sign') === 'percussion')) state.isPercussion = true;
}

/** The key of a pitched or unpitched note, or null for a rest. */
function keyOf(note: XmlNode, state: ReadState): number | null {
  const pitch = child(note, 'pitch');
  if (pitch) {
    const step = STEPS[childText(pitch, 'step') ?? ''];
    const octave = Number(childText(pitch, 'octave'));
    if (step === undefined || !Number.isFinite(octave)) return null;
    return keyOfSpelling({ step, alter: Math.round(Number(childText(pitch, 'alter') ?? 0)), octave });
  }
  if (child(note, 'unpitched')) {
    const id = child(note, 'instrument')?.attributes.id;
    return (id ? state.drumKeys.get(id) : undefined) ?? DEFAULT_DRUM_KEY;
  }
  return null;
}

function readNote(note: XmlNode, state: ReadState): void {
  if (child(note, 'grace')) return;
  const length = toTicks(Number(childText(note, 'duration') ?? 0), state.divisions);
  const isChord = !!child(note, 'chord');
  const start = isChord ? state.lastStart : state.cursor;
  const key = keyOf(note, state);
  if (key !== null && key >= 0 && key <= 127 && length > 0) addNote(note, state, { start, length, key });
  if (!isChord) {
    state.lastStart = start;
    state.cursor += length;
  }
}

/** Adds a note, or lengthens the tied note it continues. */
function addNote(note: XmlNode, state: ReadState, placed: { start: number; length: number; key: number }): void {
  const ties = childrenNamed(note, 'tie').map((tie) => tie.attributes.type);
  const joined = ties.includes('stop') ? state.open.get(placed.key) : undefined;
  if (joined && joined.tick + joined.length === placed.start) {
    joined.length += placed.length;
    if (!ties.includes('start')) state.open.delete(placed.key);
    return;
  }
  const created: ImportedNote = { tick: placed.start, length: placed.length, key: placed.key };
  state.notes.push(created);
  if (ties.includes('start')) state.open.set(placed.key, created);
  else state.open.delete(placed.key);
}

function readMeasure(measure: XmlNode, state: ReadState, result: ImportedScore): void {
  state.cursor = state.barStart;
  state.lastStart = state.barStart;
  let furthest = state.barStart;
  for (const element of measure.children) {
    if (element.name === 'attributes') readAttributes(element, state, result);
    else if (element.name === 'note') readNote(element, state);
    else if (element.name === 'backup') state.cursor = Math.max(state.barStart, state.cursor - toTicks(Number(childText(element, 'duration') ?? 0), state.divisions));
    else if (element.name === 'forward') state.cursor += toTicks(Number(childText(element, 'duration') ?? 0), state.divisions);
    else if (element.name === 'direction') readTempo(element, result);
    furthest = Math.max(furthest, state.cursor);
  }
  state.barStart += state.barTicks > 0 ? state.barTicks : furthest - state.barStart;
}

function readTempo(direction: XmlNode, result: ImportedScore): void {
  const tempo = Number(child(direction, 'sound')?.attributes.tempo);
  if (result.bpm === undefined && tempo > 0) result.bpm = tempo;
}

/** Reads a MusicXML document. Throws `XmlError` (with a sentence for the musician) when it is not a partwise score. */
export function readMusicXml(text: string, options: { part?: number } = {}): ImportedScore {
  const root = parseXml(text);
  if (root.name !== 'score-partwise') {
    throw new XmlError(root.name === 'score-timewise' ? 'This is a "timewise" MusicXML file, which AGstudio cannot read: export it as partwise (the usual kind) from your notation program.' : 'This is not a MusicXML score (it should start with a score-partwise element).');
  }
  const parts = childrenNamed(root, 'part');
  const part = parts[options.part ?? 0];
  if (!part) throw new XmlError('The file has no music in it.');
  const partList = child(root, 'part-list');
  const listed = childrenNamed(partList, 'score-part').find((entry) => entry.attributes.id === part.attributes.id);
  const result: ImportedScore = {
    notes: [],
    isPercussion: false,
    partName: childText(listed, 'part-name') ?? 'Part 1',
    partCount: parts.length,
    bars: 0,
  };
  const state: ReadState = {
    divisions: 1,
    barTicks: 0,
    barStart: 0,
    cursor: 0,
    lastStart: 0,
    open: new Map(),
    drumKeys: drumKeysOf(partList, part.attributes.id ?? ''),
    notes: result.notes,
    isPercussion: false,
  };
  for (const measure of childrenNamed(part, 'measure')) {
    readMeasure(measure, state, result);
    result.bars++;
  }
  result.isPercussion = state.isPercussion;
  result.notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
  return result;
}
