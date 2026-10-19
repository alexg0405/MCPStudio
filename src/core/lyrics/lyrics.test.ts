import { describe, expect, it } from 'vitest';
import type { LyricId, LyricWord } from '../model/types';
import { constantTempo } from '../time/ppq';
import { lyricCursor, newCursor } from './karaoke';
import { groupLines, lineText, wordLabel } from './lines';
import { lrcTime, lyricsToLrc, lyricsToText } from './lrc';
import { MAX_SYLLABLES, parseLyrics } from './parse';
import { slotsFromNotes } from './slots';
import { spreadEvenly, spreadOnSlots } from './spread';

const word = (tick: number, length: number, text: string, line = 0, continues = false): LyricWord => ({
  id: `ly_${tick}` as LyricId,
  tick,
  length,
  text,
  line,
  ...(continues ? { continues: true as const } : {}),
});

const texts = (lines: ReturnType<typeof parseLyrics>['lines']) => lines.map((line) => line.map((s) => s.text + (s.continues ? '-' : '')));

describe('parseLyrics', () => {
  it('splits lines into words, and hyphenated words into syllables', () => {
    const { lines, count } = parseLyrics('What a beau-ti-ful day\n\nI feel good\n');
    expect(texts(lines)).toEqual([
      ['What', 'a', 'beau-', 'ti-', 'ful', 'day'],
      ['I', 'feel', 'good'],
    ]);
    expect(count).toBe(9);
  });

  it('reads "beau- ti- ful" and "beau - ti - ful" as the same syllables, and a dash at the start of a token as a join', () => {
    const same = texts([parseLyrics('beau-ti-ful').lines[0]!]);
    expect(texts(parseLyrics('beau- ti- ful').lines)).toEqual(same);
    expect(texts(parseLyrics('beau - ti - ful').lines)).toEqual(same);
    expect(texts(parseLyrics('beau -ti -ful').lines)).toEqual(same);
  });

  it('a word never runs on past the end of its line; dashes alone and blank lines are ignored', () => {
    expect(texts(parseLyrics('sun-\nrise').lines)).toEqual([['sun'], ['rise']]);
    expect(parseLyrics('  \n - \n\t\n').lines).toEqual([]);
    expect(texts(parseLyrics('one\r\ntwo\rthree').lines)).toEqual([['one'], ['two'], ['three']]);
  });

  it('keeps punctuation and apostrophes, cuts very long text and very many syllables', () => {
    expect(texts(parseLyrics("Don't stop, believin'").lines)).toEqual([["Don't", 'stop,', "believin'"]]);
    expect(parseLyrics('x'.repeat(200)).lines[0]![0]!.text).toHaveLength(80);
    const big = parseLyrics(Array.from({ length: MAX_SYLLABLES + 50 }, (_, i) => `w${i}`).join(' '));
    expect(big.count).toBe(MAX_SYLLABLES);
    expect(big.isTruncated).toBe(true);
    expect(parseLyrics('a b c').isTruncated).toBe(false);
  });
});

describe('slotsFromNotes', () => {
  it('one slot per start: a chord is one slot (the highest note sets the end), and slots never overlap', () => {
    const slots = slotsFromNotes([
      { tick: 960, length: 480, key: 64 },
      { tick: 0, length: 960, key: 60 },
      { tick: 0, length: 480, key: 72 },
      { tick: 0, length: 960, key: 67 },
      { tick: 1200, length: 2000, key: 60 },
    ]);
    expect(slots).toEqual([
      { tick: 0, length: 480 },
      { tick: 960, length: 240 },
      { tick: 1200, length: 2000 },
    ]);
  });

  it('a loosely played chord (starts a few ticks apart) is still one slot', () => {
    expect(slotsFromNotes([{ tick: 0, length: 960, key: 60 }, { tick: 20, length: 940, key: 64 }])).toEqual([{ tick: 0, length: 960 }]);
  });
});

describe('spreading lyrics', () => {
  const parsed = parseLyrics('beau-ti-ful day\nsun shine');
  const slots = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ tick: i * 480, length: 480 }));

  it('onto slots: one syllable per slot in order across lines; the rest is counted', () => {
    const spread = spreadOnSlots(parsed.lines, slots, 3);
    expect(spread.words.map((w) => [w.tick, w.text, w.line, w.continues ?? false])).toEqual([
      [0, 'beau', 3, true],
      [480, 'ti', 3, true],
      [960, 'ful', 3, false],
      [1440, 'day', 3, false],
      [1920, 'sun', 4, false],
      [2400, 'shine', 4, false],
    ]);
    expect(spread.words.every((w) => w.length === 480)).toBe(true);
    expect(spread.leftover).toBe(0);
    expect(spread.emptySlots).toBe(1);
  });

  it('more syllables than notes: the extra ones are not placed and are counted', () => {
    const spread = spreadOnSlots(parsed.lines, slots.slice(0, 4));
    expect(spread.words.map((w) => w.text)).toEqual(['beau', 'ti', 'ful', 'day']);
    expect(spread.leftover).toBe(2);
    expect(spread.emptySlots).toBe(0);
  });

  it('evenly over a range: equal parts, whole ticks, no gaps', () => {
    const words = spreadEvenly(parsed.lines, { fromTick: 3840, toTick: 3840 + 3000, barTicks: 3840 });
    expect(words).toHaveLength(6);
    expect(words[0]!.tick).toBe(3840);
    for (let i = 0; i + 1 < words.length; i++) expect(words[i]!.tick + words[i]!.length).toBe(words[i + 1]!.tick);
    const last = words[5]!;
    expect(last.tick + last.length).toBe(3840 + 3000);
    expect(words.map((w) => w.line)).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it('evenly without an end: each line takes a bar (or barsPerLine bars) from the start', () => {
    const words = spreadEvenly(parsed.lines, { fromTick: 7680, barTicks: 3840 });
    expect(words.slice(0, 4).map((w) => w.tick)).toEqual([7680, 7680 + 960, 7680 + 1920, 7680 + 2880]);
    expect(words[4]!.tick).toBe(7680 + 3840);
    const two = spreadEvenly(parsed.lines, { fromTick: 0, barTicks: 3840, barsPerLine: 2 });
    expect(two[4]!.tick).toBe(7680);
    expect(two[0]!.length).toBe(1920);
  });
});

describe('lines and text', () => {
  const words = [
    word(0, 480, 'beau', 0, true),
    word(480, 480, 'ti', 0, true),
    word(960, 480, 'ful', 0),
    word(1440, 480, 'day', 0),
    word(3840, 480, 'sun', 1),
    word(4320, 480, 'shine', 1),
  ];

  it('groups words into lines by their line number, and rejoins syllables', () => {
    const lines = groupLines(words);
    expect(lines.map((l) => l.text)).toEqual(['beautiful day', 'sun shine']);
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 1920],
      [3840, 4800],
    ]);
    expect(wordLabel(words[0]!)).toBe('beau-');
    expect(wordLabel(words[2]!)).toBe('ful');
    expect(lineText(words.slice(0, 3))).toBe('beautiful');
  });

  it('two separate stretches that share a line number are still two lines when something else is between them', () => {
    const lines = groupLines([word(0, 100, 'a', 0), word(200, 100, 'b', 1), word(400, 100, 'c', 0)]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('plain text export is one line per lyric line', () => {
    expect(lyricsToText(words)).toBe('beautiful day\nsun shine');
    expect(lyricsToText([])).toBe('');
  });
});

describe('LRC export', () => {
  const tempo = constantTempo(120); // 1920 ticks a second
  const words = [
    word(0, 480, 'beau', 0, true),
    word(480, 480, 'ti', 0, true),
    word(960, 480, 'ful', 0),
    word(1440, 480, 'day', 0),
    word(1920 * 65 + 192, 480, 'sun', 1),
    word(1920 * 65 + 672, 480, 'shine', 1),
  ];

  it('formats times as mm:ss.xx (centiseconds, minutes can pass 99)', () => {
    expect(lrcTime(0)).toBe('00:00.00');
    expect(lrcTime(5.678)).toBe('00:05.68');
    expect(lrcTime(59.996)).toBe('01:00.00');
    expect(lrcTime(65.1)).toBe('01:05.10');
    expect(lrcTime(6000)).toBe('100:00.00');
    expect(lrcTime(-3)).toBe('00:00.00');
  });

  it('one timed line per lyric line, at the time its first word starts', () => {
    expect(lyricsToLrc(words, tempo, { title: 'My song' })).toBe('[ti:My song]\n[00:00.00]beautiful day\n[01:05.10]sun shine');
  });

  it('with per-word times each syllable gets its own time', () => {
    expect(lyricsToLrc(words, tempo, { perWord: true }).split('\n')[0]).toBe('[00:00.00]<00:00.00>beau<00:00.25>ti<00:00.50>ful <00:00.75>day');
  });

  it('follows tempo changes', () => {
    const slow = constantTempo(60);
    expect(lyricsToLrc([word(1920, 480, 'a')], slow)).toBe('[00:02.00]a');
  });
});

describe('the karaoke cursor', () => {
  const words = [word(100, 100, 'a'), word(300, 200, 'b'), word(600, 100, 'c')];

  it('is before the first word, then on the last word that has begun, with progress through it', () => {
    const cursor = newCursor();
    expect(lyricCursor(words, 50, cursor)).toEqual({ word: -1, progress: 0 });
    expect(lyricCursor(words, 100, cursor)).toEqual({ word: 0, progress: 0 });
    expect(lyricCursor(words, 150, cursor)).toEqual({ word: 0, progress: 0.5 });
    // Between two words it stays on the one just sung, finished.
    expect(lyricCursor(words, 250, cursor)).toEqual({ word: 0, progress: 1 });
    expect(lyricCursor(words, 400, cursor)).toEqual({ word: 1, progress: 0.5 });
    expect(lyricCursor(words, 9999, cursor)).toEqual({ word: 2, progress: 1 });
    expect(lyricCursor([], 10, cursor)).toEqual({ word: -1, progress: 0 });
  });

  it('fills the cursor it is given and makes no object of its own', () => {
    const cursor = newCursor();
    expect(lyricCursor(words, 150, cursor)).toBe(cursor);
  });
});
