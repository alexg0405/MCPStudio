/** Things written around the notes: dynamics from velocities, lyric syllables under notes and chord symbols over the bar. */
import type { Tick } from '../model/types';
import type { ChordItem, Measure, NotationChord, NotationLyric } from './types';

/** The loudness marks and the velocity (0 to 1) each begins at. */
const DYNAMIC_MARKS: ReadonlyArray<{ mark: string; from: number }> = [
  { mark: 'pp', from: 0 },
  { mark: 'p', from: 0.25 },
  { mark: 'mp', from: 0.4 },
  { mark: 'mf', from: 0.55 },
  { mark: 'f', from: 0.72 },
  { mark: 'ff', from: 0.88 },
];

function dynamicLevel(velocity: number): number {
  let level = 0;
  DYNAMIC_MARKS.forEach((entry, i) => {
    if (velocity >= entry.from) level = i;
  });
  return level;
}

/** The first chords of voice 1 of a staff, not carried over a tie, in time order. */
function voiceOneChords(measures: readonly Measure[], staff: number): ChordItem[] {
  const out: ChordItem[] = [];
  for (const measure of measures) {
    for (const item of measure.staves[staff]?.voices[0]?.items ?? []) {
      if (item.kind === 'chord' && !item.heads.every((head) => head.tiedFromPrevious)) out.push(item);
    }
  }
  return out;
}

const averageVelocity = (chord: ChordItem): number => chord.heads.reduce((sum, head) => sum + head.velocity, 0) / chord.heads.length;

/**
 * Marks the dynamics of voice 1: the first chord gets one, and a new mark is written when the loudness has moved to a
 * different level for two chords in a row (one loud note in a quiet line is an accent, not a new dynamic).
 */
export function markDynamics(measures: readonly Measure[], staff: number): void {
  const chords = voiceOneChords(measures, staff);
  let current = -1;
  chords.forEach((chord, i) => {
    const level = dynamicLevel(averageVelocity(chord));
    const next = chords[i + 1];
    const staysThere = !next || dynamicLevel(averageVelocity(next)) === level;
    if (current === -1 || (level !== current && staysThere)) {
      chord.dynamic = (DYNAMIC_MARKS[level] as { mark: string }).mark;
      current = level;
    }
  });
}

/** A syllable further than this (ticks, a 1/32 note) from a note's start does not belong to it. */
const LYRIC_REACH = 120;

/** Puts each syllable under the voice-1 chord that starts nearest to it (within a 1/32 note), one syllable per chord. */
export function placeLyrics(measures: readonly Measure[], staff: number, lyrics: readonly NotationLyric[]): void {
  const starts: Array<{ chord: ChordItem; tick: Tick }> = [];
  for (const measure of measures) {
    for (const item of measure.staves[staff]?.voices[0]?.items ?? []) {
      if (item.kind === 'chord' && !item.heads.every((head) => head.tiedFromPrevious)) starts.push({ chord: item, tick: measure.startTick + item.tick });
    }
  }
  for (const word of lyrics) {
    let best: { chord: ChordItem; distance: number } | null = null;
    for (const entry of starts) {
      const distance = Math.abs(entry.tick - word.tick);
      if (distance <= LYRIC_REACH && !entry.chord.lyric && (!best || distance < best.distance)) best = { chord: entry.chord, distance };
    }
    if (best) best.chord.lyric = { text: word.text, continues: word.continues };
  }
}

/** Hands each bar the chord symbols that start in it (the bar-relative tick). */
export function placeChordSymbols(measures: Measure[], chords: readonly NotationChord[]): void {
  for (const measure of measures) {
    measure.chordSymbols = chords
      .filter((chord) => chord.tick >= measure.startTick && chord.tick < measure.startTick + measure.ticks)
      .map((chord) => ({ tick: chord.tick - measure.startTick, text: chord.text }));
  }
}
