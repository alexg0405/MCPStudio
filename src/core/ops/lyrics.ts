import type { Draft } from 'immer';
import { groupLines } from '../lyrics/lines';
import { MAX_SYLLABLE_CHARS, parseLyrics } from '../lyrics/parse';
import type { PlacedWord } from '../lyrics/spread';
import { newId } from '../model/ids';
import type { LyricId, LyricWord, Project, Tick } from '../model/types';

// Draft mutators for the lyrics lane (`Project.lyrics`). Words never overlap: every placement carves its span out of the
// words already there (trimming or removing them), so the lane always reads as one line of words in time order.

/** The most words a project keeps (a long song is a few hundred syllables). */
export const MAX_LYRIC_WORDS = 4096;

const wholeTick = (value: number): Tick => Math.max(0, Math.round(value));
const wholeLength = (value: number): Tick => Math.max(1, Math.round(value));

/** Text as the lane stores it: no spaces or edge hyphens, at most MAX_SYLLABLE_CHARS; null when nothing is left. */
export function cleanLyricText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, '').replace(/^[-–—]+|[-–—]+$/g, '').slice(0, MAX_SYLLABLE_CHARS);
  return cleaned === '' ? null : cleaned;
}

/** The stored record for a placed word. */
function toWord(id: LyricId, placed: PlacedWord): LyricWord | null {
  const text = cleanLyricText(placed.text);
  if (text === null) return null;
  const word: LyricWord = {
    id,
    tick: wholeTick(placed.tick),
    length: wholeLength(placed.length),
    text,
    line: Math.max(0, Math.round(placed.line)),
  };
  if (placed.continues) word.continues = true;
  return word;
}

/** The words in time order (a copy, safe to read while the draft changes). */
function inTimeOrder(draft: Draft<Project>): LyricWord[] {
  return (Object.values(draft.lyrics ?? {}) as LyricWord[]).sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : 1));
}

/**
 * Takes the span [from, to) away from every word except those in `keep`: a word inside it goes, one that starts before it
 * is cut short where it begins, one that starts inside it begins where it ends.
 */
function carve(draft: Draft<Project>, from: Tick, to: Tick, keep: ReadonlySet<LyricId> = new Set()): void {
  const words = draft.lyrics;
  if (!words) return;
  for (const word of Object.values(words) as LyricWord[]) {
    if (keep.has(word.id)) continue;
    const end = word.tick + word.length;
    if (end <= from || word.tick >= to) continue;
    if (word.tick >= from && end <= to) delete words[word.id];
    else if (word.tick < from) word.length = from - word.tick;
    else {
      word.tick = to;
      word.length = end - to;
    }
  }
}

/** Drops the track when its last word is gone. */
function dropEmptyTrack(draft: Draft<Project>): void {
  if (draft.lyrics && Object.keys(draft.lyrics).length === 0) delete draft.lyrics;
}

/**
 * Puts words on the lane (each replaces what was there under it); returns their ids. With `replaceSpan` the whole span
 * from the first word to the end of the last is cleared first, so pasting lyrics for a section replaces that section.
 */
export function placeLyricWords(draft: Draft<Project>, words: readonly PlacedWord[], options: { replaceSpan?: boolean } = {}): LyricId[] {
  const room = Math.max(0, MAX_LYRIC_WORDS - Object.keys(draft.lyrics ?? {}).length);
  const wanted = [...words].sort((a, b) => a.tick - b.tick).slice(0, options.replaceSpan ? MAX_LYRIC_WORDS : room);
  if (wanted.length === 0) return [];
  if (!draft.lyrics) draft.lyrics = {};
  if (options.replaceSpan) {
    const last = wanted[wanted.length - 1] as PlacedWord;
    carve(draft, wholeTick(wanted[0]!.tick), wholeTick(last.tick) + wholeLength(last.length));
  }
  const ids: LyricId[] = [];
  for (const placed of wanted) {
    const id = newId.lyric();
    const word = toWord(id, placed);
    if (!word) continue;
    if (!options.replaceSpan) carve(draft, word.tick, word.tick + word.length);
    draft.lyrics[id] = word;
    ids.push(id);
  }
  dropEmptyTrack(draft);
  return ids;
}

/**
 * Retypes a word. Text with hyphens or spaces ("beau-ti-ful", "so long") becomes several words sharing the old word's span
 * equally; returns the ids in order (the first is the word's own), or an empty list when the text has no words.
 */
export function retextLyricWord(draft: Draft<Project>, id: LyricId, text: string): LyricId[] {
  const word = draft.lyrics?.[id];
  if (!draft.lyrics || !word) return [];
  const syllables = parseLyrics(text).lines.flat();
  if (syllables.length === 0) return [];
  const { tick, length, line } = word;
  const parts = syllables.slice(0, Math.max(1, length));
  const ids: LyricId[] = [id];
  const first = parts[0]!;
  word.text = cleanLyricText(first.text) ?? word.text;
  if (first.continues) word.continues = true;
  else delete word.continues;
  const size = Math.max(1, Math.floor(length / parts.length));
  word.length = parts.length === 1 ? length : size;
  parts.slice(1).forEach((part, index) => {
    const partId = newId.lyric();
    const start = tick + size * (index + 1);
    const isLast = index === parts.length - 2;
    const piece = toWord(partId, { tick: start, length: isLast ? tick + length - start : size, text: part.text, line, ...(part.continues ? { continues: true as const } : {}) });
    if (!piece) return;
    draft.lyrics![partId] = piece;
    ids.push(partId);
  });
  return ids;
}

/** Moves words by `deltaTicks` (they keep their lengths and stay at or after tick 0); words they land on are trimmed. */
export function moveLyricWords(draft: Draft<Project>, ids: readonly LyricId[], deltaTicks: Tick): void {
  const words = ids.map((id) => draft.lyrics?.[id]).filter((word): word is Draft<LyricWord> => !!word);
  if (words.length === 0) return;
  const earliest = Math.min(...words.map((word) => word.tick));
  const shift = Math.round(Math.max(-earliest, deltaTicks));
  for (const word of words) word.tick += shift;
  const moved = new Set(words.map((word) => word.id));
  for (const word of words) carve(draft, word.tick, word.tick + word.length, moved);
}

/** Moves a word's edges (start and length); words it grows over are trimmed. */
export function resizeLyricWord(draft: Draft<Project>, id: LyricId, startTick: Tick, length: Tick): void {
  const word = draft.lyrics?.[id];
  if (!word) return;
  word.tick = wholeTick(startTick);
  word.length = wholeLength(length);
  carve(draft, word.tick, word.tick + word.length, new Set([id]));
}

/** Removes words. */
export function removeLyricWords(draft: Draft<Project>, ids: readonly LyricId[]): void {
  if (!draft.lyrics) return;
  for (const id of ids) delete draft.lyrics[id];
  dropEmptyTrack(draft);
}

/** Clears the lyrics, or only [from, to) of them (words reaching in are cut). Returns how many words went. */
export function clearLyrics(draft: Draft<Project>, from?: Tick, to?: Tick): number {
  if (!draft.lyrics) return 0;
  const before = Object.keys(draft.lyrics).length;
  if (from === undefined || to === undefined) delete draft.lyrics;
  else {
    carve(draft, from, to);
    dropEmptyTrack(draft);
  }
  return before - Object.keys(draft.lyrics ?? {}).length;
}

/** Starts a new line at a word: it and the words after it in its line get a line number of their own. */
export function breakLyricLine(draft: Draft<Project>, id: LyricId): boolean {
  const lines = groupLines(inTimeOrder(draft));
  const line = lines.find((entry) => entry.words.some((word) => word.id === id));
  if (!line || line.words[0]?.id === id) return false;
  const nextNumber = Math.max(...inTimeOrder(draft).map((word) => word.line)) + 1;
  const from = line.words.findIndex((word) => word.id === id);
  for (const word of line.words.slice(from)) {
    const stored = draft.lyrics?.[word.id];
    if (stored) stored.line = nextNumber;
  }
  const before = line.words[from - 1];
  const storedBefore = before ? draft.lyrics?.[before.id] : undefined;
  if (storedBefore) delete storedBefore.continues;
  return true;
}

/** Joins a word's line to the one before it (they become one line). False when it is the first line. */
export function joinLyricLine(draft: Draft<Project>, id: LyricId): boolean {
  const lines = groupLines(inTimeOrder(draft));
  const index = lines.findIndex((entry) => entry.words.some((word) => word.id === id));
  const previous = lines[index - 1];
  const line = lines[index];
  if (!line || !previous) return false;
  const number = (previous.words[0] as LyricWord).line;
  for (const word of line.words) {
    const stored = draft.lyrics?.[word.id];
    if (stored) stored.line = number;
  }
  return true;
}
