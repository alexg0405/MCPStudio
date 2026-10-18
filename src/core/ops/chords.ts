import type { Draft } from 'immer';
import { isQualityId, mod12, type ChordSymbol } from '../harmony/chord';
import { newId } from '../model/ids';
import type { ChordEvent, ChordId, Project, Tick } from '../model/types';

// Draft mutators for the chord track (`Project.chords`). Chords never overlap: every placement carves its span out of
// the chords already there (trimming, splitting or removing them), so the lane always reads as one line of chords.

/** The most chords a project keeps (a hundred bars of half-bar chords is 200). */
export const MAX_CHORDS = 4096;

const wholeTick = (value: number): Tick => Math.max(0, Math.round(value));
const wholeLength = (value: number): Tick => Math.max(1, Math.round(value));

/** The stored record for a chord symbol (a bass equal to the root is dropped). */
function toEvent(id: ChordId, startTick: Tick, length: Tick, chord: ChordSymbol, confidence?: number): ChordEvent {
  const event: ChordEvent = {
    id,
    tick: wholeTick(startTick),
    length: wholeLength(length),
    root: mod12(chord.root),
    quality: isQualityId(chord.quality) ? chord.quality : 'maj',
  };
  if (chord.bass !== undefined && mod12(chord.bass) !== event.root) event.bass = mod12(chord.bass);
  if (confidence !== undefined && Number.isFinite(confidence)) {
    event.confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  }
  return event;
}

/** A stored chord as a symbol (what the harmony code works on). */
export const symbolOf = (event: Pick<ChordEvent, 'root' | 'quality' | 'bass'>): ChordSymbol => ({
  root: event.root,
  quality: event.quality,
  ...(event.bass !== undefined ? { bass: event.bass } : {}),
});

/** Removes the span [from, to) from every chord except `keep`: trims, splits or deletes what overlaps. */
function carve(draft: Draft<Project>, from: Tick, to: Tick, keep?: ChordId): void {
  const chords = draft.chords;
  if (!chords) return;
  for (const event of Object.values(chords) as ChordEvent[]) {
    if (event.id === keep) continue;
    const end = event.tick + event.length;
    if (end <= from || event.tick >= to) continue;
    const startsInside = event.tick >= from;
    const endsInside = end <= to;
    if (startsInside && endsInside) {
      delete chords[event.id];
    } else if (!startsInside && !endsInside) {
      // The new span sits inside it: keep both sides.
      const rightId = newId.chord();
      chords[rightId] = { ...event, id: rightId, tick: to, length: end - to };
      event.length = from - event.tick;
    } else if (!startsInside) {
      event.length = from - event.tick;
    } else {
      event.tick = to;
      event.length = end - to;
    }
  }
}

/** Puts a chord on the track (replacing what was there); returns its id. */
export function setChord(
  draft: Draft<Project>,
  startTick: Tick,
  length: Tick,
  chord: ChordSymbol,
  options: { id?: ChordId; confidence?: number } = {},
): ChordId {
  const id = options.id ?? newId.chord();
  const event = toEvent(id, startTick, length, chord, options.confidence);
  if (!draft.chords) draft.chords = {};
  carve(draft, event.tick, event.tick + event.length);
  draft.chords[id] = event;
  return id;
}

/** A chord to place: where, how long, which, and how sure a detector was (absent for typed chords). */
export interface ChordSpan {
  tick: Tick;
  length: Tick;
  chord: ChordSymbol;
  confidence?: number;
}

/** Whether none of the chords on the track overlaps [from, to). */
function isTrackFreeBetween(draft: Draft<Project>, from: Tick, to: Tick): boolean {
  if (!draft.chords) return true;
  return !(Object.values(draft.chords) as ChordEvent[]).some((event) => event.tick < to && event.tick + event.length > from);
}

/**
 * Puts several chords on the track in one go (each replaces what was there); returns their ids. A list that lands on an
 * empty stretch and does not overlap itself (a detected or typed progression) is added without carving each one.
 */
export function placeChords(draft: Draft<Project>, spans: readonly ChordSpan[]): ChordId[] {
  const wanted = spans.slice(0, MAX_CHORDS).map((span) => ({ ...span, tick: wholeTick(span.tick), length: wholeLength(span.length) }));
  wanted.sort((a, b) => a.tick - b.tick);
  const first = wanted[0];
  const last = wanted[wanted.length - 1];
  const selfOverlap = wanted.some((span, i) => i > 0 && span.tick < (wanted[i - 1] as ChordSpan).tick + (wanted[i - 1] as ChordSpan).length);
  const isFree = first && last && !selfOverlap && isTrackFreeBetween(draft, first.tick, last.tick + last.length);
  const ids: ChordId[] = [];
  for (const span of wanted) {
    const options = span.confidence === undefined ? {} : { confidence: span.confidence };
    if (!isFree) {
      ids.push(setChord(draft, span.tick, span.length, span.chord, options));
      continue;
    }
    const id = newId.chord();
    if (!draft.chords) draft.chords = {};
    draft.chords[id] = toEvent(id, span.tick, span.length, span.chord, span.confidence);
    ids.push(id);
  }
  return ids;
}

/** Changes the chord of an event. A hand edit clears its detection confidence. */
export function editChord(draft: Draft<Project>, id: ChordId, chord: ChordSymbol): void {
  const event = draft.chords?.[id];
  if (!event) return;
  const next = toEvent(id, event.tick, event.length, chord);
  event.root = next.root;
  event.quality = next.quality;
  if (next.bass !== undefined) event.bass = next.bass;
  else delete event.bass;
  delete event.confidence;
}

/** Moves a chord (same length); chords it lands on are trimmed. */
export function moveChord(draft: Draft<Project>, id: ChordId, startTick: Tick): void {
  const event = draft.chords?.[id];
  if (!event) return;
  event.tick = wholeTick(startTick);
  carve(draft, event.tick, event.tick + event.length, id);
}

/** Moves a chord's edges (start and length); chords it grows over are trimmed. */
export function resizeChord(draft: Draft<Project>, id: ChordId, startTick: Tick, length: Tick): void {
  const event = draft.chords?.[id];
  if (!event) return;
  event.tick = wholeTick(startTick);
  event.length = wholeLength(length);
  carve(draft, event.tick, event.tick + event.length, id);
}

/** Cuts a chord in two at `at` (the second half is a new chord with the same symbol); returns its id, or null. */
export function splitChord(draft: Draft<Project>, id: ChordId, at: Tick): ChordId | null {
  const event = draft.chords?.[id];
  if (!draft.chords || !event || at <= event.tick || at >= event.tick + event.length) return null;
  const rightId = newId.chord();
  const splitTick = wholeTick(at);
  draft.chords[rightId] = { ...event, id: rightId, tick: splitTick, length: event.tick + event.length - splitTick };
  event.length = splitTick - event.tick;
  return rightId;
}

/** Removes one chord (the track disappears with its last chord). */
export function removeChord(draft: Draft<Project>, id: ChordId): void {
  if (!draft.chords) return;
  delete draft.chords[id];
  if (Object.keys(draft.chords).length === 0) delete draft.chords;
}

/** Clears the chord track, or only [from, to) of it (chords reaching in are trimmed). Returns how many chords went. */
export function clearChords(draft: Draft<Project>, from?: Tick, to?: Tick): number {
  if (!draft.chords) return 0;
  const before = Object.keys(draft.chords).length;
  if (from === undefined || to === undefined) delete draft.chords;
  else {
    carve(draft, from, to);
    if (Object.keys(draft.chords).length === 0) delete draft.chords;
  }
  return before - (draft.chords ? Object.keys(draft.chords).length : 0);
}

/** Moves every chord by `semitones` (the whole track follows a key change). */
export function transposeChords(draft: Draft<Project>, semitones: number): void {
  if (!draft.chords) return;
  for (const event of Object.values(draft.chords) as ChordEvent[]) {
    event.root = mod12(event.root + semitones);
    if (event.bass !== undefined) event.bass = mod12(event.bass + semitones);
  }
}
