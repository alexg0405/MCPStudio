/**
 * Measures of a generated song, read from its notes alone (not from how they were made), so the tests hold the generator
 * to what a listener would hear: melodies on chord tones at the strong beats, a bass that follows the chords, voice
 * leading without parallel fifths and octaves, a motif that comes back changed.
 */
import { chordPitchClasses, mod12 } from '../harmony/chord';
import type { BeatNote, BeatTrack } from '../beat/spec';
import { chordAtStep } from './harmony';
import type { SongPattern, SongPlan } from './types';
import { outerParallels } from './voicing';

/** A count out of a total, with the share it makes (1 when there is nothing to count). */
export interface Ratio {
  count: number;
  total: number;
  ratio: number;
}

const ratioOf = (count: number, total: number): Ratio => ({ count, total, ratio: total === 0 ? 1 : count / total });

/** The tracks of a pattern that play one sound. */
const tracksNamed = (pattern: SongPattern, names: readonly string[]): BeatTrack[] =>
  pattern.spec.tracks.filter((track) => names.includes(track.name));

/** The steps of a bar a note on a strong beat starts on (the first and third beat), and the length (steps) from which a note counts as strong. */
const STRONG_STEPS = [0, 8];
const STRONG_LENGTH_STEPS = 4;

/** Whether a note is strong: it starts on the first or third beat, or it lasts a beat or more. */
export const isStrongNote = (note: BeatNote): boolean =>
  STRONG_STEPS.includes(note.step % 16) || (note.len ?? 1) >= STRONG_LENGTH_STEPS;

/** The share of the lead's strong notes that are tones of the chord under them. */
export function leadChordToneRatio(plan: SongPlan): Ratio {
  let count = 0;
  let total = 0;
  for (const pattern of plan.patterns.filter((entry) => entry.kind === 'melody')) {
    for (const track of tracksNamed(pattern, ['Lead', 'Counter'])) {
      for (const note of track.notes.filter(isStrongNote)) {
        const tones = chordPitchClasses(chordAtStep(pattern.chords, note.step));
        total++;
        if (tones.includes(mod12(note.key ?? 0))) count++;
      }
    }
  }
  return ratioOf(count, total);
}

/** The notes of the bass tracks of a pattern. */
const bassNotes = (pattern: SongPattern): BeatNote[] =>
  pattern.spec.tracks
    .filter((track) => track.sound === 'bass' || track.sound === '808')
    .flatMap((track) => track.notes);

/** The share of the bass notes that start with a chord (on its first step) that play its root (or slash bass). */
export function bassRootRatio(plan: SongPlan): Ratio {
  let count = 0;
  let total = 0;
  for (const pattern of plan.patterns.filter((entry) => entry.kind === 'band')) {
    for (const note of bassNotes(pattern)) {
      const placed = pattern.chords.find((entry) => Math.abs(entry.step - note.step) < 0.01);
      if (!placed) continue;
      total++;
      if (mod12(note.key ?? 0) === mod12(placed.chord.bass ?? placed.chord.root)) count++;
    }
  }
  return ratioOf(count, total);
}

/** How near a note may sit to the next chord's root, in the chord's last beat, to count as an approach note. */
const APPROACH_SEMITONES = 2;
const APPROACH_WINDOW_STEPS = 4;

/** The share of the bass notes that are tones of their chord, or approach notes into the next chord's root. */
export function bassChordToneRatio(plan: SongPlan): Ratio {
  let count = 0;
  let total = 0;
  for (const pattern of plan.patterns.filter((entry) => entry.kind === 'band')) {
    for (const note of bassNotes(pattern)) {
      const key = note.key ?? 0;
      const chord = chordAtStep(pattern.chords, note.step);
      const placedIndex = pattern.chords.findIndex(
        (entry) => note.step >= entry.step && note.step < entry.step + entry.length,
      );
      const placed = pattern.chords[placedIndex];
      const next = pattern.chords[(placedIndex + 1) % pattern.chords.length];
      total++;
      if (chordPitchClasses(chord).includes(mod12(key))) {
        count++;
        continue;
      }
      const isLate = placed !== undefined && note.step >= placed.step + placed.length - APPROACH_WINDOW_STEPS;
      const nextRoot = next ? mod12(next.chord.root) : -1;
      const distance = Math.min(mod12(key - nextRoot), mod12(nextRoot - key));
      if (isLate && distance <= APPROACH_SEMITONES) count++;
    }
  }
  return ratioOf(count, total);
}

/** The voicings of a chord part in the order they sound: the keys that start together, repeats of the same voicing counted once. */
function voicingsOf(track: BeatTrack): { step: number; keys: number[] }[] {
  const byStep = new Map<number, number[]>();
  for (const note of track.notes) byStep.set(note.step, [...(byStep.get(note.step) ?? []), note.key ?? 0]);
  const voicings = [...byStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, keys]) => ({ step, keys: keys.sort((a, b) => a - b) }));
  return voicings.filter(
    (voicing, index) => index === 0 || voicing.keys.join() !== (voicings[index - 1] as { keys: number[] }).keys.join(),
  );
}

/** How many chord changes of the chord parts there are, and how many of them move the outer voices in parallel fifths or octaves (the loop's last chord into its first included). */
export function parallelOuterVoices(plan: SongPlan): Ratio {
  let count = 0;
  let total = 0;
  for (const pattern of plan.patterns.filter((entry) => entry.kind === 'band')) {
    for (const track of tracksNamed(pattern, ['Pad', 'Keys'])) {
      const voicings = voicingsOf(track);
      for (let index = 0; index < voicings.length; index++) {
        const before = voicings[index] as { step: number; keys: number[] };
        const after = voicings[(index + 1) % voicings.length] as { step: number; keys: number[] };
        if (before === after) continue;
        total++;
        count += outerParallels(
          { keys: before.keys, chord: chordAtStep(pattern.chords, before.step) },
          { keys: after.keys, chord: chordAtStep(pattern.chords, after.step) },
        );
      }
    }
  }
  return ratioOf(count, total);
}

/** The longest gap (steps) a note's shape records: a note held longer counts as held. */
const MAX_SHAPE_GAP_STEPS = 8;

/**
 * The melody's shape, note by note, for each melody pattern's lead: how long to the next note (the rhythm) and whether the
 * line goes up, down or stays (the contour). Two statements of a motif have the same shape even when the chords under them
 * move the exact intervals by a semitone or two.
 */
function leadShapes(plan: SongPlan): string[][] {
  return plan.patterns
    .filter((entry) => entry.kind === 'melody')
    .map((pattern) => {
      const notes = (tracksNamed(pattern, ['Lead'])[0]?.notes ?? []).slice().sort((a, b) => a.step - b.step);
      return notes.slice(1).map((note, index) => {
        const before = notes[index] as BeatNote;
        const gap = Math.min(MAX_SHAPE_GAP_STEPS, Math.round(note.step - before.step));
        return `${gap}${Math.sign((note.key ?? 0) - (before.key ?? 0))}`;
      });
    });
}

/**
 * How much of a song's melody is made of material that comes back: the share of 3-note shapes (rhythm and contour) that
 * occur more than once in the song's melody patterns, and the share of the distinct shapes that occur exactly once.
 */
export function motifReuse(plan: SongPlan): { repeated: number; unique: number; total: number } {
  const seen = new Map<string, number>();
  let total = 0;
  for (const shapes of leadShapes(plan)) {
    for (let index = 0; index + 2 < shapes.length; index++) {
      const key = shapes.slice(index, index + 3).join(' ');
      seen.set(key, (seen.get(key) ?? 0) + 1);
      total++;
    }
  }
  const counts = [...seen.values()];
  const repeated = counts.filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  const unique = counts.filter((count) => count === 1).length;
  return {
    repeated: total === 0 ? 0 : repeated / total,
    unique: counts.length === 0 ? 0 : unique / counts.length,
    total,
  };
}

/** The first and last notes (by pitch) the lead plays, across the whole song. */
export function leadRange(plan: SongPlan): { low: number; high: number } {
  const keys = plan.patterns
    .filter((entry) => entry.kind === 'melody')
    .flatMap((pattern) => tracksNamed(pattern, ['Lead']).flatMap((track) => track.notes.map((note) => note.key ?? 0)));
  return { low: Math.min(...keys), high: Math.max(...keys) };
}

/** The share of the notes of the song's melody patterns that start off the beat (not on a multiple of 4 steps): the syncopation. */
export function syncopation(plan: SongPlan): Ratio {
  const notes = plan.patterns
    .filter((entry) => entry.kind === 'melody')
    .flatMap((pattern) => tracksNamed(pattern, ['Lead']).flatMap((track) => track.notes));
  return ratioOf(notes.filter((note) => note.step % 4 !== 0).length, notes.length);
}
