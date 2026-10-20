/**
 * Reading the lyrics: the words in time order, the lines they form, the words inside a stretch of the song or of a
 * pattern, and the compact text the AI reads. Memoized on the stored record, which is immutable, so every window shares
 * one sorted list.
 */
import { groupLines, type LyricLine } from '../lyrics/lines';
import type { LyricWord, PatternId, Project, Tick } from '../model/types';
import { ticksPerBar } from '../time/ppq';
import { patternPlace } from './chords';
import { patternLength } from './queries';

const NO_WORDS: readonly LyricWord[] = [];
const sortedCache = new WeakMap<object, LyricWord[]>();
const linesCache = new WeakMap<object, LyricLine[]>();

/** The words in time order (shared: do not change the array). */
export function lyricsSorted(project: Pick<Project, 'lyrics'>): readonly LyricWord[] {
  const record = project.lyrics;
  if (!record) return NO_WORDS;
  let list = sortedCache.get(record);
  if (!list) {
    list = (Object.values(record) as LyricWord[]).sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : 1));
    sortedCache.set(record, list);
  }
  return list;
}

/** The lyrics as lines (shared: do not change them). */
export function lyricLines(project: Pick<Project, 'lyrics'>): readonly LyricLine[] {
  const record = project.lyrics;
  if (!record) return [];
  let lines = linesCache.get(record);
  if (!lines) {
    lines = groupLines(lyricsSorted(project));
    linesCache.set(record, lines);
  }
  return lines;
}

/** The words that overlap the span [from, to). */
export function lyricsBetween(project: Pick<Project, 'lyrics'>, from: Tick, to: Tick): LyricWord[] {
  return lyricsSorted(project).filter((word) => word.tick < to && word.tick + word.length > from);
}

/** Where the lyrics end (0 when there are none). */
export function lyricsEnd(project: Pick<Project, 'lyrics'>): Tick {
  const list = lyricsSorted(project);
  return list.reduce((end, word) => Math.max(end, word.tick + word.length), 0);
}

/** The highest line number in use (-1 when there are no lyrics): new lines are numbered after it. */
export function lastLineNumber(project: Pick<Project, 'lyrics'>): number {
  return lyricsSorted(project).reduce((highest, word) => Math.max(highest, word.line), -1);
}

/** A word as a pattern sees it: pattern ticks, not song ticks. */
export interface PatternLyric {
  tick: Tick;
  length: Tick;
  word: LyricWord;
}

/**
 * How far a pattern tick is from its song tick where the pattern first plays (song tick = pattern tick + shift): the
 * mapping the chord track and the lyrics use to line the song up with a pattern. A pattern that is not in the song plays
 * from the start of it.
 */
export function patternToSongShift(project: Project, patternId: PatternId, length?: Tick): Tick {
  const pattern = project.patterns[patternId];
  const span = length ?? (pattern ? patternLength(pattern, project.transport.timeSig) : 0);
  const { songStart, offset } = patternPlace(project, patternId);
  return songStart - (span > 0 ? offset % span : 0);
}

/**
 * The lyrics as a pattern plays them: the words of the song stretch the pattern's first clip covers, in pattern ticks, cut
 * to the pattern's length (the same mapping the chord track uses). A pattern that is not in the song reads the lyrics from
 * the start of the song.
 */
export function patternLyrics(project: Project, patternId: PatternId, length?: Tick): PatternLyric[] {
  const pattern = project.patterns[patternId];
  if (!pattern || !project.lyrics) return [];
  const span = length ?? patternLength(pattern, project.transport.timeSig);
  if (span <= 0) return [];
  const { songStart } = patternPlace(project, patternId);
  const shift = patternToSongShift(project, patternId, span);
  const out: PatternLyric[] = [];
  for (const word of lyricsBetween(project, songStart, songStart + span)) {
    const from = Math.max(0, Math.max(word.tick, songStart) - shift);
    const to = Math.min(span, Math.min(word.tick + word.length, songStart + span) - shift);
    if (to > from) out.push({ tick: from, length: to - from, word });
  }
  return out;
}

/** The most lyric lines the AI's project text lists (the rest is a count). */
const AI_LINES = 16;
/** The longest a listed line is (characters). */
const AI_LINE_CHARS = 60;

/**
 * The lyrics as the AI reads them, one entry per lyric line: "bar 5: beautiful day". Long lyrics list the first lines and
 * a count. Empty when there are no lyrics.
 */
export function lyricTrackLines(project: Project): string[] {
  const lines = lyricLines(project);
  if (lines.length === 0) return [];
  const bar = ticksPerBar(project.transport.timeSig);
  const shown = lines.slice(0, AI_LINES).map((line) => {
    const text = line.text.length > AI_LINE_CHARS ? `${line.text.slice(0, AI_LINE_CHARS - 1)}…` : line.text;
    return `bar ${Math.floor(line.start / bar) + 1}: ${text}`;
  });
  if (lines.length > AI_LINES) shown.push(`… and ${lines.length - AI_LINES} more lines (get_lyrics has them all)`);
  return shown;
}
