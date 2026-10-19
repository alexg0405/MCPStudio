import { describe, expect, it } from 'vitest';
import { parseLyrics } from '../lyrics/parse';
import { spreadEvenly, spreadOnSlots } from '../lyrics/spread';
import { History } from '../history/history';
import { createEmptyProject } from '../model/defaults';
import type { LyricId, LyricWord, Project } from '../model/types';
import { lastLineNumber, lyricLines, lyricsBetween, lyricsEnd, lyricsSorted, lyricTrackLines, patternLyrics } from '../query/lyrics';
import { migrateProject, repairProject } from '../schema/migrate';
import {
  breakLyricLine,
  clearLyrics,
  joinLyricLine,
  MAX_LYRIC_WORDS,
  moveLyricWords,
  placeLyricWords,
  removeLyricWords,
  resizeLyricWord,
  retextLyricWord,
} from './lyrics';

function setup() {
  let doc: Project = createEmptyProject();
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  return { history, get: () => doc };
}

const spread = (text: string, from = 0, step = 480) => {
  const syllables = parseLyrics(text).lines;
  return spreadOnSlots(
    syllables,
    Array.from({ length: 64 }, (_, i) => ({ tick: from + i * step, length: step })),
  ).words;
};

const shown = (p: Project) => lyricsSorted(p).map((w) => `${w.tick}:${w.length}:${w.text}${w.continues ? '-' : ''}`);

describe('placing lyrics', () => {
  it('words go on the lane in time order, with line numbers, as one undo step', () => {
    const { history, get } = setup();
    const before = get();
    expect(history.transact('Paste lyrics', (d) => void placeLyricWords(d, spread('beau-ti-ful day\nsun shine')))).toBe(true);
    expect(shown(get())).toEqual(['0:480:beau-', '480:480:ti-', '960:480:ful', '1440:480:day', '1920:480:sun', '2400:480:shine']);
    expect(lyricLines(get()).map((l) => l.text)).toEqual(['beautiful day', 'sun shine']);
    expect(lyricsEnd(get())).toBe(2880);
    expect(lastLineNumber(get())).toBe(1);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
    expect(get().lyrics).toBeUndefined();
    expect(history.redo()).toBe(true);
    expect(lyricsSorted(get())).toHaveLength(6);
  });

  it('a word placed on others trims or removes them (words never overlap)', () => {
    const { history, get } = setup();
    history.transact('Paste', (d) => void placeLyricWords(d, spread('a b c d')));
    history.transact('New', (d) => void placeLyricWords(d, [{ tick: 700, length: 1000, text: 'X', line: 9 }]));
    // a (0–480) stays, b (480–960) is cut to 480–700, c (960–1440) is gone, d (1440–1920) starts at 1700.
    expect(shown(get())).toEqual(['0:480:a', '480:220:b', '700:1000:X', '1700:220:d']);
  });

  it('replacing a span clears what was under it first', () => {
    const { history, get } = setup();
    history.transact('Paste', (d) => void placeLyricWords(d, spread('a b c d e f', 0, 480)));
    history.transact('Replace', (d) => void placeLyricWords(d, spread('x y', 480, 960), { replaceSpan: true }));
    expect(shown(get())).toEqual(['0:480:a', '480:960:x', '1440:960:y', '2400:480:f']);
  });

  it('text is cleaned (no spaces, no edge hyphens); empty text is skipped; the word limit holds', () => {
    const { history, get } = setup();
    history.transact('Paste', (d) =>
      void placeLyricWords(d, [
        { tick: 0, length: 100, text: ' -hel lo- ', line: 0 },
        { tick: 100, length: 100, text: ' - ', line: 0 },
      ]),
    );
    expect(shown(get())).toEqual(['0:100:hello']);
    const many = Array.from({ length: MAX_LYRIC_WORDS + 10 }, (_, i) => ({ tick: i * 10, length: 10, text: 'w', line: 0 }));
    history.transact('Many', (d) => void placeLyricWords(d, many, { replaceSpan: true }));
    expect(lyricsSorted(get())).toHaveLength(MAX_LYRIC_WORDS);
  });
});

describe('editing lyrics', () => {
  const placed = () => {
    const s = setup();
    s.history.transact('Paste', (d) => void placeLyricWords(d, spread('beau-ti-ful day')));
    const ids = lyricsSorted(s.get()).map((w) => w.id);
    return { ...s, ids };
  };

  it('retyping a word with hyphens makes syllables that share its span; undo restores it', () => {
    const { history, get, ids } = placed();
    const before = get();
    history.transact('Edit word', (d) => void retextLyricWord(d, ids[3]!, 'to-mor-row'));
    expect(shown(get()).slice(3)).toEqual(['1440:160:to-', '1600:160:mor-', '1760:160:row']);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
    history.transact('Edit word', (d) => void retextLyricWord(d, ids[0]!, 'bow'));
    expect(shown(get())[0]).toBe('0:480:bow');
    expect(history.transact('Nothing', (d) => void retextLyricWord(d, ids[0]!, ' - '))).toBe(false);
  });

  it('moving words keeps their lengths, stays at or after tick 0, and trims what they land on', () => {
    const { history, get, ids } = placed();
    history.transact('Move', (d) => void moveLyricWords(d, [ids[0]!, ids[1]!], 700));
    // "ful" is covered by the two moved words and goes; "day" starts where they end.
    expect(shown(get())).toEqual(['700:480:beau-', '1180:480:ti-', '1660:260:day']);
    history.transact('Back', (d) => void moveLyricWords(d, [ids[0]!, ids[1]!], -5000));
    expect(lyricsSorted(get())[0]!.tick).toBe(0);
  });

  it('resizing moves the edges and trims neighbours; one undo step each', () => {
    const { history, get, ids } = placed();
    const before = get();
    history.transact('Resize', (d) => void resizeLyricWord(d, ids[1]!, 400, 1000));
    expect(shown(get())).toEqual(['0:400:beau-', '400:1000:ti-', '1400:40:ful', '1440:480:day']);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
  });

  it('removing and clearing: the track goes with its last word; clearing a range cuts words that reach in', () => {
    const { history, get, ids } = placed();
    history.transact('Remove', (d) => void removeLyricWords(d, [ids[0]!]));
    expect(lyricsSorted(get())).toHaveLength(3);
    // Words reaching into the range are cut, not removed: "ti" ends where it starts, "ful" starts where it ends.
    history.transact('Clear range', (d) => void expect(clearLyrics(d, 600, 1100)).toBe(0));
    expect(shown(get())).toEqual(['480:120:ti-', '1100:340:ful', '1440:480:day']);
    history.transact('Clear range', (d) => void expect(clearLyrics(d, 400, 1500)).toBe(2));
    expect(shown(get())).toEqual(['1500:420:day']);
    history.transact('Clear', (d) => void expect(clearLyrics(d)).toBe(1));
    expect(get().lyrics).toBeUndefined();
    expect(history.undo()).toBe(true);
    expect(lyricsSorted(get())).toHaveLength(1);
  });

  it('a line can be broken at a word and joined to the line before', () => {
    const { history, get, ids } = placed();
    expect(history.transact('Break', (d) => void expect(breakLyricLine(d, ids[2]!)).toBe(true))).toBe(true);
    expect(lyricLines(get()).map((l) => l.text)).toEqual(['beauti', 'ful day']);
    // The word before the break no longer runs on into the next line.
    expect(get().lyrics![ids[1]!]!.continues).toBeUndefined();
    expect(history.transact('First word', (d) => void expect(breakLyricLine(d, ids[0]!)).toBe(false))).toBe(false);
    history.transact('Join', (d) => void expect(joinLyricLine(d, ids[3]!)).toBe(true));
    expect(lyricLines(get())).toHaveLength(1);
  });
});

describe('reading lyrics', () => {
  it('words between ticks, the compact AI lines, and the words as a pattern plays them', () => {
    const { history, get } = setup();
    history.transact('Paste', (d) => void placeLyricWords(d, spread('one two three four', 3840, 960)));
    expect(lyricsBetween(get(), 4900, 5000).map((w) => w.text)).toEqual(['two']);
    expect(lyricTrackLines(get())).toEqual(['bar 2: one two three four']);
    const many = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join('\n');
    history.transact('Many', (d) => void placeLyricWords(d, spreadEvenly(parseLyrics(many).lines, { fromTick: 0, barTicks: 3840 }), { replaceSpan: true }));
    const lines = lyricTrackLines(get());
    expect(lines).toHaveLength(17);
    expect(lines[16]).toMatch(/^… and 24 more lines/);
    expect(lines.join('\n').length).toBeLessThan(700);
    expect(lyricTrackLines(createEmptyProject())).toEqual([]);
  });

  it('a pattern placed in the song sees the words of its stretch in its own ticks', () => {
    const { history, get } = setup();
    const patternId = get().patternOrder[0]!;
    history.transact('Place pattern', (d) => {
      d.playlist.clips['clip_p' as never] = {
        kind: 'pattern',
        id: 'clip_p' as never,
        laneId: d.playlist.laneOrder[0]!,
        start: 3840,
        length: 3840,
        patternId,
        offset: 0,
      } as never;
      placeLyricWords(d, [
        { tick: 0, length: 480, text: 'before', line: 0 },
        { tick: 3840 + 960, length: 480, text: 'inside', line: 1 },
        { tick: 7680 + 100, length: 480, text: 'after', line: 2 },
      ]);
    });
    expect(patternLyrics(get(), patternId, 3840).map((l) => [l.word.text, l.tick, l.length])).toEqual([['inside', 960, 480]]);
  });
});

describe('repairing lyrics', () => {
  const cloneJson = (p: Project) => JSON.parse(JSON.stringify(p));
  const repaired = (raw: unknown) => repairProject(migrateProject(raw).project);

  function projectWithLyrics() {
    const s = setup();
    s.history.transact('Paste', (d) => void placeLyricWords(d, spread('beau-ti-ful day')));
    return s.get();
  }

  it('good lyrics survive a save and load unchanged, with no repairs', () => {
    const p = projectWithLyrics();
    const { project, repairs } = repaired(cloneJson(p));
    expect(repairs).toEqual([]);
    expect(project.lyrics).toEqual(p.lyrics);
  });

  it('a project without lyrics comes back without them', () => {
    expect(repaired(cloneJson(createEmptyProject())).project.lyrics).toBeUndefined();
  });

  it('damaged words are dropped, bad fields put right, overlaps trimmed, and it is idempotent', () => {
    const raw = cloneJson(projectWithLyrics());
    const words = Object.values(raw.lyrics) as Array<Record<string, unknown>>;
    words[0]!.tick = -5;
    words[1]!.line = 'x';
    words[1]!.continues = 'yes';
    words[2]!.text = `  ${'long'.repeat(40)}  `;
    words[3]!.length = 900;
    raw.lyrics['bad'] = { id: 'bad', tick: 0, length: 10, text: 3, line: 0 };
    const { project, repairs } = repaired(raw);
    expect(repairs.join(' ')).toMatch(/Dropped 2 lyric words/);
    const kept = lyricsSorted(project) as LyricWord[];
    expect(kept.map((w) => w.text.length)).toEqual([2, 80, 3]);
    expect(kept[0]!.line).toBe(0);
    expect(kept[0]!.continues).toBeUndefined();
    expect(kept.every((w) => w.id === (Object.keys(project.lyrics!).find((k) => k === w.id) as LyricId))).toBe(true);
    // No overlaps left.
    for (let i = 0; i + 1 < kept.length; i++) expect(kept[i]!.tick + kept[i]!.length).toBeLessThanOrEqual(kept[i + 1]!.tick);
    expect(repaired(cloneJson(project)).repairs).toEqual([]);
  });

  it('a lyrics track that is not an object is forgotten, and one with nothing readable is removed', () => {
    const raw = cloneJson(projectWithLyrics());
    raw.lyrics = [1, 2];
    expect(repaired(raw).project.lyrics).toBeUndefined();
    raw.lyrics = { a: { id: 'a' } };
    const out = repaired(raw);
    expect(out.project.lyrics).toBeUndefined();
    expect(out.repairs.join(' ')).toMatch(/Dropped 1 lyric word/);
  });

  it('words that start at the same tick leave one, and too many words are cut to the limit', () => {
    const raw = cloneJson(projectWithLyrics());
    const [first] = Object.values(raw.lyrics) as Array<Record<string, unknown>>;
    raw.lyrics['twin'] = { ...first, id: 'twin' };
    const out = repaired(raw);
    expect(lyricsSorted(out.project).filter((w) => w.tick === 0)).toHaveLength(1);
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_LYRIC_WORDS + 5; i++) many[`w${i}`] = { id: `w${i}`, tick: i * 10, length: 10, text: 'a', line: 0 };
    raw.lyrics = many;
    expect(lyricsSorted(repaired(raw).project)).toHaveLength(MAX_LYRIC_WORDS);
  });
});
