/**
 * Repair of the lyrics (`Project.lyrics`, optional): damaged words are dropped, text that is too long is cut, a bad line
 * number or `continues` flag is put right, overlapping words are trimmed so each ends where the next starts, and an
 * empty track is removed.
 */
import { MAX_SYLLABLE_CHARS } from '../../lyrics/parse';
import { countOf, noun, type RepairLog } from './log';
import { hasOwn, isIntegerBetween, isObject, isSet, isString, type JsonObject } from '../json-values';

/** The most words the lyrics keep (same as `MAX_LYRIC_WORDS` in core/ops/lyrics.ts). */
const MAX_LYRIC_TRACK = 4096;
const WORD = noun('lyric word');

/** Whether a stored word has the fields it needs, in range (its text and line are put right afterwards). */
function isValidWord(id: string, word: unknown): word is JsonObject {
  return (
    isObject(word) &&
    word.id === id &&
    isIntegerBetween(word.tick, 0, Infinity) &&
    isIntegerBetween(word.length, 1, Infinity) &&
    isString(word.text)
  );
}

/** Puts the text (no spaces, at most the limit) and the line number right; false when the word has no text left. */
function cleanWord(word: JsonObject): boolean {
  const text = (word.text as string).replace(/\s+/g, '').slice(0, MAX_SYLLABLE_CHARS);
  if (text === '') return false;
  word.text = text;
  if (!isIntegerBetween(word.line, 0, Infinity)) word.line = 0;
  if (hasOwn(word, 'continues') && word.continues !== true) delete word.continues;
  return true;
}

/** Shortens each word that runs into the next (words sorted by tick); returns how many were shortened. */
function trimOverlaps(sorted: JsonObject[]): number {
  let trimmed = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const word = sorted[i]!;
    const gapToNext = (sorted[i + 1]!.tick as number) - (word.tick as number);
    if (gapToNext < (word.length as number)) {
      word.length = gapToNext;
      trimmed++;
    }
  }
  return trimmed;
}

/** Repairs the lyrics in place, logging what it did. */
export function repairLyrics(project: JsonObject, log: RepairLog): void {
  if (!isSet(project, 'lyrics')) return;
  if (!isObject(project.lyrics)) {
    delete project.lyrics;
    log.add('Forgot the damaged lyrics (notes and patterns are not changed).');
    return;
  }
  const kept: JsonObject[] = [];
  let dropped = 0;
  for (const [id, word] of Object.entries(project.lyrics)) {
    if (isValidWord(id, word) && cleanWord(word)) kept.push(word);
    else dropped++;
  }
  kept.sort((a, b) => (a.tick as number) - (b.tick as number));
  if (kept.length > MAX_LYRIC_TRACK) {
    dropped += kept.length - MAX_LYRIC_TRACK;
    kept.length = MAX_LYRIC_TRACK;
  }
  const trimmed = trimOverlaps(kept);
  // A word squeezed to nothing by one that starts at the same tick is gone.
  const usable = kept.filter((word) => (word.length as number) >= 1);
  dropped += kept.length - usable.length;
  if (usable.length === 0) delete project.lyrics;
  else project.lyrics = Object.fromEntries(usable.map((word) => [word.id as string, word]));
  if (dropped) log.add(`Dropped ${countOf(dropped, WORD)} from the lyrics that could not be read.`);
  if (trimmed) log.add('Trimmed overlapping words on the lyrics lane.');
}
