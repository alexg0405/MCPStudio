/**
 * Lyrics as lines and text: words grouped into the lines they were written in, a word as it is drawn (a hyphen after a
 * syllable that goes on), and a line as it reads. Pure.
 */
import type { LyricWord, Tick } from '../model/types';

/** One line of lyrics: its words in time order and where it starts and ends. */
export interface LyricLine {
  /** Position in the lyrics, from 0. */
  index: number;
  words: LyricWord[];
  start: Tick;
  end: Tick;
  /** The line as it reads: syllables rejoined into words. */
  text: string;
}

/** A word as drawn on the lane, under a note or in the window: its text, with a hyphen when it goes on. */
export const wordLabel = (word: Pick<LyricWord, 'text' | 'continues'>): string => (word.continues ? `${word.text}-` : word.text);

/** A line of words as it reads ("beau-ti-ful day" becomes "beautiful day"). */
export function lineText(words: readonly Pick<LyricWord, 'text' | 'continues'>[]): string {
  let text = '';
  for (const [i, word] of words.entries()) {
    text += word.text;
    if (i < words.length - 1 && !word.continues) text += ' ';
  }
  return text;
}

/** Groups words (in time order) into lines: a new line starts where `line` differs from the word before. */
export function groupLines(sorted: readonly LyricWord[]): LyricLine[] {
  const lines: LyricLine[] = [];
  let currentNumber: number | null = null;
  for (const word of sorted) {
    const last = lines[lines.length - 1];
    if (last && currentNumber === word.line) {
      last.words.push(word);
      last.end = Math.max(last.end, word.tick + word.length);
      continue;
    }
    currentNumber = word.line;
    lines.push({ index: lines.length, words: [word], start: word.tick, end: word.tick + word.length, text: '' });
  }
  for (const line of lines) line.text = lineText(line.words);
  return lines;
}
