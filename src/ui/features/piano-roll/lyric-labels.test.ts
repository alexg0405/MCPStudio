import { describe, expect, it } from 'vitest';
import type { LyricId, LyricWord, Note, NoteId } from '@core/model/types';
import type { PatternLyric } from '@core/query/lyrics';
import { lyricLabelsFor, MATCH_EARLY_TICKS } from './lyric-labels';

const note = (id: string, tick: number, key: number, length = 480): Note => ({ id: id as NoteId, tick, length, key, velocity: 0.8 });
const word = (tick: number, length: number, text: string, continues = false): PatternLyric => ({
  tick,
  length,
  word: { id: `ly_${tick}` as LyricId, tick, length, text, line: 0, ...(continues ? { continues: true as const } : {}) } as LyricWord,
});

describe('lyric labels under notes', () => {
  const notes = [note('a', 0, 60), note('b', 480, 62), note('c', 960, 64), note('d', 1440, 65)];

  it('each word goes under the note that starts where it does; syllables carry their hyphen', () => {
    const labels = lyricLabelsFor(notes, [word(0, 480, 'beau', true), word(480, 480, 'ti', true), word(960, 480, 'ful'), word(1440, 480, 'day')]);
    expect(labels.map((l) => [l.note.id, l.text])).toEqual([
      ['a', 'beau-'],
      ['b', 'ti-'],
      ['c', 'ful'],
      ['d', 'day'],
    ]);
  });

  it('a word dragged a little early still finds its note, but not one that is far off', () => {
    const near = lyricLabelsFor(notes, [word(480 - MATCH_EARLY_TICKS + 10, 480, 'x')]);
    expect(near.map((l) => l.note.id)).toEqual(['b']);
    expect(lyricLabelsFor(notes, [word(480 - MATCH_EARLY_TICKS - 40, 40, 'x')])).toEqual([]);
  });

  it('of notes that start together the highest carries the word; each note carries one word', () => {
    const chord = [note('low', 0, 48), note('mid', 0, 60), note('top', 0, 72), note('next', 480, 62)];
    const labels = lyricLabelsFor(chord, [word(0, 960, 'one'), word(0, 960, 'two')]);
    expect(labels.map((l) => [l.note.id, l.text])).toEqual([
      ['top', 'one'],
      ['mid', 'two'],
    ]);
  });

  it('a word with no note under it is left out (the lane still shows it)', () => {
    expect(lyricLabelsFor(notes, [word(5000, 480, 'late')])).toEqual([]);
    expect(lyricLabelsFor([], [word(0, 480, 'x')])).toEqual([]);
  });
});
