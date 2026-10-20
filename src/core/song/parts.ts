/**
 * The chord parts of a pattern (pads, keys): the chords of the loop voiced with voice leading and no parallel fifths or
 * octaves in the outer voices, then played in the style's rhythm for that kind of section.
 */
import type { BeatNote, BeatTrack } from '../beat/spec';
import { PATTERN_STEPS, STEPS_PER_BAR } from './harmony';
import { COMP_HITS, type BarHits, type ChordPart, type CompShape } from './profiles';
import type { PlacedChord } from './types';
import { voiceLoop } from './voicing';

/** The velocity of a held chord. */
const HELD_VELOCITY = 0.7;

/** The notes of one chord part played as `shape`: every key of each chord's voicing struck together. */
function notesFor(chords: readonly PlacedChord[], voicings: readonly number[][], shape: CompShape, strength: number): BeatNote[] {
  const notes: BeatNote[] = [];
  chords.forEach((placed, index) => {
    const keys = voicings[index] as number[];
    const end = placed.step + placed.length;
    // A held chord keeps its whole length; the other shapes start again in every bar.
    const bars = shape === 'held' ? [placed.step] : barStartsIn(placed);
    for (const barStart of bars) {
      const hits: BarHits = shape === 'held' ? [[0, placed.length, HELD_VELOCITY]] : COMP_HITS[shape];
      for (const [offset, length, velocity] of hits) {
        const step = barStart + offset;
        if (step >= end || step >= PATTERN_STEPS) continue;
        for (const key of keys) {
          notes.push({ step, len: Math.min(length, end - step), key, vel: Math.round(Math.min(1, velocity * strength) * 1000) / 1000 });
        }
      }
    }
  });
  return notes;
}

/** The first step of each bar a chord covers. */
function barStartsIn(chord: PlacedChord): number[] {
  const starts: number[] = [];
  for (let step = chord.step; step < chord.step + chord.length; step += STEPS_PER_BAR) starts.push(step);
  return starts;
}

/** The track of one chord part for a pattern's chords. `strength` scales its velocities (1 is the part's own level). */
export function chordPartTrack(part: ChordPart, shape: CompShape, chords: readonly PlacedChord[], strength: number): BeatTrack {
  const voicings = voiceLoop(
    chords.map((placed) => placed.chord),
    part.center,
  );
  return { name: part.name, sound: part.sound, notes: notesFor(chords, voicings, shape, strength) };
}
