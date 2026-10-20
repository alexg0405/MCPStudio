/**
 * Melodies for the song's lead: a two-bar motif (`motif.ts`) put on the chords of a four-bar pattern, then developed. The
 * first two bars state the idea, the last two answer it (turned upside down, or the same shape a step higher), and the
 * pattern ends on a long chord tone. Every note that starts on a strong beat (the first or third) or lasts a beat or more
 * is a tone of the chord under it; the notes between may pass through the scale, but only by step on both sides, so
 * nothing clashes.
 */
import { chordPitchClasses, mod12 } from '../harmony/chord';
import { scalePitchClasses } from '../harmony/scale';
import type { BeatNote } from '../beat/spec';
import { chordAtStep, PATTERN_STEPS, STEPS_PER_BAR } from './harmony';
import {
  answered,
  inverted,
  makeMotif,
  ornamented,
  shifted,
  syncopated,
  thinned,
  transposed,
  type MotifNote,
} from './motif';
import type { StyleProfile } from './profiles';
import { streamFor, type Rng } from './rng';
import type { PlacedChord, SongKey } from './types';

/** The motifs of a song: one for the verses, one for the hooks (all the melodies of a song grow from these two). */
export interface SongMotifs {
  verse: MotifNote[];
  hook: MotifNote[];
}

/** Makes a song's two motifs from its seed. */
export function makeSongMotifs(profile: StyleProfile, seed: number): SongMotifs {
  const family = profile.lead.family;
  return {
    verse: makeMotif('verse', family, streamFor(seed, 'motif:verse')),
    hook: makeMotif('hook', family, streamFor(seed, 'motif:hook')),
  };
}

/** The melodies of a song: the verse in its first and later statements, the hook in three strengths, the bridge, a teaser for the intro. */
export type MelodyPlan = 'verse' | 'verse2' | 'hook' | 'hook2' | 'hookFinal' | 'bridge' | 'teaser';

/** What a melody is written from. */
export interface MelodyInput {
  plan: MelodyPlan;
  key: SongKey;
  /** The four-bar chord loop the melody plays over. */
  chords: readonly PlacedChord[];
  profile: StyleProfile;
  motifs: SongMotifs;
  seed: number;
  /** 1 to 5: how hard the section plays (velocity). */
  energy: number;
}

/** The most scale steps a note may leap from the one before when a chord tone nearer that is available. */
const MAX_LEAP = 5;
/** A note that starts on one of these steps of the bar (the first and third beat) must be a chord tone. */
const STRONG_STEPS = [0, 8];
/** A note this long (steps) is heard as a chord tone too: a beat. */
const LONG_NOTE_STEPS = 4;
/** A note that is not a chord tone may last at most this long (steps). */
const PASSING_NOTE_STEPS = 2;
/** The scale steps in an octave. */
const SCALE_STEPS_PER_OCTAVE = 7;
/** The cadence note at the end of a pattern lasts this long (steps), or until the pattern's end. */
const CADENCE_STEPS = 8;

/** The keys of the song's scale between `low` and `high` (MIDI), ascending, with their chord-tone test. */
class ScaleSpace {
  readonly keys: number[] = [];

  constructor(
    key: SongKey,
    readonly low: number,
    readonly high: number,
  ) {
    const pitchClasses = new Set(scalePitchClasses({ root: key.root, scale: key.minor ? 'minor' : 'major' }));
    for (let note = low; note <= high; note++) if (pitchClasses.has(mod12(note))) this.keys.push(note);
  }

  /** The index of the scale key nearest to a MIDI key. */
  nearest(note: number): number {
    let best = 0;
    this.keys.forEach((candidate, index) => {
      if (Math.abs(candidate - note) < Math.abs((this.keys[best] as number) - note)) best = index;
    });
    return best;
  }

  clamp(index: number): number {
    if (index < 0) return Math.min(this.keys.length - 1, -index);
    if (index > this.keys.length - 1) return Math.max(0, 2 * (this.keys.length - 1) - index);
    return index;
  }
}

/** The index of the chord tone nearest to `wanted` (ties go toward `lean`), within the scale's range. */
function nearestChordTone(space: ScaleSpace, wanted: number, tones: ReadonlySet<number>, lean: number): number {
  let best = -1;
  space.keys.forEach((note, index) => {
    if (!tones.has(mod12(note))) return;
    if (best < 0) {
      best = index;
      return;
    }
    const distance = Math.abs(index - wanted);
    const bestDistance = Math.abs(best - wanted);
    const isCloser = distance < bestDistance || (distance === bestDistance && Math.abs(index - lean) < Math.abs(best - lean));
    if (isCloser) best = index;
  });
  return best < 0 ? wanted : best;
}

/**
 * The chord tone nearest to `wanted` among those that lie in the direction of the motif's move from `previous` (a move up goes to
 * a higher chord tone, never back to the same note), so the contour survives being put on the chord. With none that way: the nearest.
 */
function chordToneToward(space: ScaleSpace, previous: number, wanted: number, tones: ReadonlySet<number>, direction: number): number {
  let best = -1;
  space.keys.forEach((note, index) => {
    if (!tones.has(mod12(note)) || (index - previous) * direction <= 0) return;
    if (best < 0 || Math.abs(index - wanted) < Math.abs(best - wanted)) best = index;
  });
  return best < 0 ? nearestChordTone(space, wanted, tones, previous) : best;
}

/** Whether a note must be a chord tone: it starts on a strong beat, or it is long. */
const isStrong = (note: MotifNote): boolean => STRONG_STEPS.includes(note.step % STEPS_PER_BAR) || note.len >= LONG_NOTE_STEPS;

/** The note's index, given a clamp that keeps an in-range leap. */
function leapLimited(space: ScaleSpace, chosen: number, previous: number, tones: ReadonlySet<number>): number {
  if (Math.abs(chosen - previous) <= MAX_LEAP) return chosen;
  const toward = previous + Math.sign(chosen - previous) * MAX_LEAP;
  return nearestChordTone(space, toward, tones, previous);
}

/** The scale indexes of a motif put on the chords: strong notes on chord tones, the rest by step or snapped to one. */
function placeOnChords(
  motif: readonly MotifNote[],
  chords: readonly PlacedChord[],
  space: ScaleSpace,
  startIndex: number,
): number[] {
  const toneSets = (step: number): Set<number> => new Set(chordPitchClasses(chordAtStep(chords, step)));
  const indexes: number[] = [];
  let previous = startIndex;
  motif.forEach((note, position) => {
    const tones = toneSets(note.step);
    const wanted = space.clamp(previous + note.move);
    let chosen = wanted;
    if (position === 0) {
      chosen = nearestChordTone(space, wanted, tones, previous);
    } else if (isStrong(note)) {
      const snapped =
        note.move === 0
          ? nearestChordTone(space, wanted, tones, previous)
          : chordToneToward(space, previous, wanted, tones, Math.sign(note.move));
      chosen = leapLimited(space, snapped, previous, tones);
    }
    indexes.push(chosen);
    previous = chosen;
  });
  return indexes;
}

/** Whether a note that is not on a chord tone is a passing or neighbour note: short, and reached and left by step. */
function isGoodPassingNote(motif: readonly MotifNote[], indexes: readonly number[], position: number): boolean {
  const note = motif[position] as MotifNote;
  const before = indexes[position - 1];
  const after = indexes[position + 1];
  if (note.len > PASSING_NOTE_STEPS || before === undefined || after === undefined) return false;
  const here = indexes[position] as number;
  return Math.abs(here - before) <= 1 && Math.abs(after - here) <= 1;
}

/** Snaps every weak note that is neither a chord tone nor a good passing note to the nearest chord tone. */
function settleWeakNotes(
  motif: readonly MotifNote[],
  indexes: number[],
  chords: readonly PlacedChord[],
  space: ScaleSpace,
): void {
  motif.forEach((note, position) => {
    const tones = new Set(chordPitchClasses(chordAtStep(chords, note.step)));
    const index = indexes[position] as number;
    if (tones.has(mod12(space.keys[index] as number)) || isGoodPassingNote(motif, indexes, position)) return;
    const before = indexes[position - 1];
    const direction = before === undefined ? 0 : Math.sign(index - before);
    indexes[position] =
      before === undefined || direction === 0
        ? nearestChordTone(space, index, tones, index)
        : chordToneToward(space, before, index, tones, direction);
  });
}

/** The last note of a pattern: a chord tone (the root if it is near), held, so the phrase ends instead of stopping. */
function settleCadence(
  motif: MotifNote[],
  indexes: number[],
  chords: readonly PlacedChord[],
  space: ScaleSpace,
): void {
  const last = motif[motif.length - 1];
  if (!last) return;
  const chord = chordAtStep(chords, last.step);
  const tones = new Set(chordPitchClasses(chord));
  const current = indexes[indexes.length - 1] as number;
  const rootsOnly = new Set([mod12(chord.root)]);
  const root = nearestChordTone(space, current, rootsOnly, current);
  indexes[indexes.length - 1] = Math.abs(root - current) <= 2 ? root : nearestChordTone(space, current, tones, current);
  last.len = Math.max(last.len, Math.min(CADENCE_STEPS, PATTERN_STEPS - last.step));
}

/** Notes from a motif and its scale indexes: the velocity follows the beat and the plan's strength, with a little seeded life. */
function toBeatNotes(
  motif: readonly MotifNote[],
  indexes: readonly number[],
  space: ScaleSpace,
  strength: number,
  random: Rng,
): BeatNote[] {
  return motif.map((note, position) => {
    const onBeat = note.step % 4 === 0;
    const accent = isStrong(note) ? 0.07 : onBeat ? 0 : -0.07;
    const life = (random.next() - 0.5) * 0.06;
    const vel = Math.max(0.3, Math.min(1, strength + accent + life));
    const nextStep = motif[position + 1]?.step ?? PATTERN_STEPS;
    return {
      step: note.step,
      // A lead plays one note at a time: a note ends where the next begins.
      len: Math.max(0.5, Math.min(note.len, PATTERN_STEPS - note.step, nextStep - note.step)),
      key: space.keys[indexes[position] as number] as number,
      vel: Math.round(vel * 1000) / 1000,
    };
  });
}

/** How strongly each plan plays (a velocity 0 to 1 before the beat's accent), and how a section's energy changes it. */
const PLAN_STRENGTH: Record<MelodyPlan, number> = {
  verse: 0.72,
  verse2: 0.76,
  hook: 0.86,
  hook2: 0.88,
  hookFinal: 0.92,
  bridge: 0.66,
  teaser: 0.55,
};

/** The motif notes of a plan's four bars: the statement, then the response. */
function developed(input: MelodyInput, random: Rng): { notes: MotifNote[]; startOffset: number } {
  const { verse, hook } = input.motifs;
  const second = (motif: readonly MotifNote[]) => shifted(motif, 2 * STEPS_PER_BAR);
  switch (input.plan) {
    case 'verse':
      return { notes: [...verse, ...second(transposed(inverted(verse), 1))], startOffset: -1 };
    case 'verse2': {
      // The same statement with one note moved, and the answer a little busier: the listener knows it, and it is not a copy.
      const response = ornamented(transposed(inverted(verse), 1), random);
      return { notes: [...syncopated(verse, random), ...second(response)], startOffset: -1 };
    }
    case 'hook':
      return { notes: [...hook, ...second(transposed(hook, random.chance(0.5) ? 1 : -1))], startOffset: 1 };
    case 'hook2':
      return { notes: [...hook, ...second(answered(inverted(hook), random))], startOffset: 1 };
    case 'hookFinal':
      return {
        notes: [...ornamented(hook, random), ...second(ornamented(transposed(hook, 1), random))],
        startOffset: SCALE_STEPS_PER_OCTAVE - 1,
      };
    case 'bridge':
      return { notes: [...thinned(inverted(verse)), ...second(thinned(verse))], startOffset: -3 };
    case 'teaser':
      return { notes: [...hook, ...second(hook)].filter((note) => note.step % 32 < STEPS_PER_BAR), startOffset: 0 };
  }
}

/** The index to start a melody on: a chord tone of the first chord, near the middle of the lead's range moved by `offset` scale steps. */
function startIndexOf(space: ScaleSpace, chords: readonly PlacedChord[], offset: number): number {
  const middle = space.nearest((space.low + space.high) / 2);
  const tones = new Set(chordPitchClasses(chordAtStep(chords, 0)));
  return nearestChordTone(space, space.clamp(middle + offset), tones, middle);
}

/** A lead melody for a four-bar pattern of the song. */
export function songMelody(input: MelodyInput): BeatNote[] {
  const random = streamFor(input.seed, `melody:${input.plan}`);
  const { low, high } = input.profile.lead;
  const space = new ScaleSpace(input.key, low, high);
  const { notes, startOffset } = developed(input, random);
  const motif = notes.filter((note) => note.step < PATTERN_STEPS).map((note) => ({ ...note }));
  if (motif.length === 0) return [];
  const indexes = placeOnChords(motif, input.chords, space, startIndexOf(space, input.chords, startOffset));
  settleWeakNotes(motif, indexes, input.chords, space);
  if (input.plan !== 'teaser') settleCadence(motif, indexes, input.chords, space);
  const energy = 0.9 + 0.025 * input.energy;
  return toBeatNotes(motif, indexes, space, PLAN_STRENGTH[input.plan] * energy, random);
}
