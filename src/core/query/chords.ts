/**
 * Reading the chord track: the chords in time order, the chord at a tick, the chords as a pattern sees them (its first place
 * in the song) and the compact text the AI reads ("bars 1–8: Am7 | F | C | G"). Memoized on the stored record, which is
 * immutable, so every window shares one sorted list.
 */
import { formatChord, keyUsesFlats, sameChord, type ChordSymbol } from '../harmony/chord';
import { keyMode } from '../harmony/scale';
import type { ChordEvent, PatternId, Project, Tick } from '../model/types';
import { symbolOf } from '../ops/chords';
import { patternLength } from './queries';
import { ticksPerBar } from '../time/ppq';

const sortedCache = new WeakMap<object, ChordEvent[]>();

/** The chords in time order (shared: do not change the array). */
export function chordsSorted(project: Pick<Project, 'chords'>): readonly ChordEvent[] {
  const record = project.chords;
  if (!record) return NO_CHORDS;
  let list = sortedCache.get(record);
  if (!list) {
    list = (Object.values(record) as ChordEvent[]).sort((a, b) => a.tick - b.tick);
    sortedCache.set(record, list);
  }
  return list;
}

const NO_CHORDS: readonly ChordEvent[] = [];

/** The chord that sounds at a song tick, or null in a gap. */
export function chordAt(project: Pick<Project, 'chords'>, tick: Tick): ChordEvent | null {
  const list = chordsSorted(project);
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const event = list[middle] as ChordEvent;
    if (tick < event.tick) high = middle - 1;
    else if (tick >= event.tick + event.length) low = middle + 1;
    else return event;
  }
  return null;
}

/** The chords that overlap the span [from, to). */
export function chordsBetween(project: Pick<Project, 'chords'>, from: Tick, to: Tick): ChordEvent[] {
  return chordsSorted(project).filter((event) => event.tick < to && event.tick + event.length > from);
}

/** Where the chord track ends (0 when there are no chords). */
export function chordTrackEnd(project: Pick<Project, 'chords'>): Tick {
  const list = chordsSorted(project);
  const last = list[list.length - 1];
  return last ? last.tick + last.length : 0;
}

/** Whether chord names in this project read better with flats (from the song key; sharps without one). */
export function projectUsesFlats(project: Pick<Project, 'transport'>): boolean {
  const key = project.transport.key;
  return key ? keyUsesFlats(key.root, keyMode(key.scale)) : false;
}

/** A chord as the pattern sees it: pattern ticks, not song ticks. */
export interface PatternChord {
  tick: Tick;
  length: Tick;
  chord: ChordSymbol;
  event: ChordEvent;
}

/** Where a pattern first plays in the song: the start of its earliest clip and how far into it the clip starts. */
export function patternPlace(project: Project, patternId: PatternId): { songStart: Tick; offset: Tick } {
  let best: { songStart: Tick; offset: Tick } | null = null;
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.patternId !== patternId || clip.muted) continue;
    if (!best || clip.start < best.songStart) best = { songStart: clip.start, offset: clip.offset };
  }
  return best ?? { songStart: 0, offset: 0 };
}

/**
 * The chord track as a pattern plays it: the chords of the song stretch its first clip covers, in pattern ticks, cut to the
 * pattern's length. A pattern that is not in the song reads the chords from the start of the song. `length` overrides the
 * stretch (for a pattern that is still empty).
 */
export function patternChords(project: Project, patternId: PatternId, length?: Tick): PatternChord[] {
  const pattern = project.patterns[patternId];
  if (!pattern) return [];
  const span = length ?? patternLength(pattern, project.transport.timeSig);
  if (span <= 0) return [];
  const { songStart, offset } = patternPlace(project, patternId);
  const shift = songStart - (offset % span);
  const out: PatternChord[] = [];
  for (const event of chordsBetween(project, songStart, songStart + span)) {
    // A clip that starts part-way into the pattern shifts the chords; what falls outside the pattern is left out.
    const from = Math.max(0, Math.max(event.tick, songStart) - shift);
    const to = Math.min(span, Math.min(event.tick + event.length, songStart + span) - shift);
    if (to > from) out.push({ tick: from, length: to - from, chord: symbolOf(event), event });
  }
  return out;
}

/** The chord a pattern tick sits on, or null. */
export function patternChordAt(chords: readonly PatternChord[], tick: Tick): PatternChord | null {
  for (const entry of chords) if (tick >= entry.tick && tick < entry.tick + entry.length) return entry;
  return null;
}

const BARS_PER_LINE = 8;

/** One bar of the chord track as text: its chords ("Am7", "Am7·E7" for two) or "–" for none. */
function barText(project: Project, bar: number, barTicks: Tick, flats: boolean): string {
  const from = bar * barTicks;
  const names: string[] = [];
  let previous: ChordSymbol | null = null;
  for (const event of chordsBetween(project, from, from + barTicks)) {
    const symbol = symbolOf(event);
    if (!previous || !sameChord(previous, symbol)) names.push(formatChord(symbol, flats));
    previous = symbol;
  }
  return names.length ? names.join('·') : '–';
}

/**
 * The chord track as the AI reads it, a bar per entry: "bars 1–8: Am7 | F | C | G | Am7 | F | C | G". Eight-bar lines that
 * read the same share one line ("bars 1–8, 17–24: …"). Empty when the project has no chords.
 */
export function chordTrackLines(project: Project): string[] {
  const end = chordTrackEnd(project);
  if (end <= 0) return [];
  const barTicks = ticksPerBar(project.transport.timeSig);
  const bars = Math.ceil(end / barTicks);
  const flats = projectUsesFlats(project);
  const byText = new Map<string, string[]>();
  for (let first = 0; first < bars; first += BARS_PER_LINE) {
    const last = Math.min(bars, first + BARS_PER_LINE);
    const entries: string[] = [];
    for (let bar = first; bar < last; bar++) entries.push(barText(project, bar, barTicks, flats));
    const text = entries.join(' | ');
    const range = last - first === 1 ? `${first + 1}` : `${first + 1}–${last}`;
    byText.set(text, [...(byText.get(text) ?? []), range]);
  }
  const lines: string[] = [];
  for (const [text, ranges] of byText) lines.push(`${ranges.length > 1 || ranges[0]?.includes('–') ? 'bars' : 'bar'} ${ranges.join(', ')}: ${text}`);
  return lines;
}
