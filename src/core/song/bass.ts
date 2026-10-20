/**
 * The bass line of a pattern, from the chords under it and the kick above it. Each style moves its own way (see `BassRule`),
 * but the rule under all of them is the same: a bass note is the chord's root (or its fifth or octave), and it starts again
 * where the chord changes. Times are 1/16 steps from the start of the four-bar pattern.
 */
import { chordPitchClasses, mod12, type ChordSymbol } from '../harmony/chord';
import { makeBassline } from '../harmony/bassline';
import type { BeatNote, BeatTrack } from '../beat/spec';
import type { Style } from '../beat/style';
import { bassPitchClass, chordAtStep, PATTERN_STEPS, STEPS_PER_BAR } from './harmony';
import type { BassRule, StyleProfile } from './profiles';
import { streamFor, type Rng } from './rng';
import type { PlacedChord } from './types';

/** The highest key a synth bass jumps up an octave to (B3), and the highest its fifth sits on (G3): a bass stays a bass. */
const OCTAVE_CEILING = 59;
const FIFTH_CEILING = 55;
/** An 808 plays between E1 (28) and E2 (39); a synth bass between C2 (36) and B2 (47): the octave its notes sit in. */
const LOW_808 = 28;
const LOW_BASS = 36;
/** The highest key an 808 slides to (E2 plus an octave is too high: it stops sounding like a bass). */
const MAX_808 = 40;
/** An 808 note rings at most this many steps (the sound dies away on its own, long holds only blur the next hit). */
const MAX_808_STEPS = 12;
/** The lowest key an 808 slides down to (C1): under it the note is felt, not heard. */
const MIN_808_SLIDE = 24;
/** The slide into the next note starts this many steps before the held note ends, overlapping it by half a step. */
const SLIDE_LEAD_STEPS = 1;
/** The bars of a pattern whose last 808 note slides into the next: drill every bar, trap every second, the rest at the loop's end. */
const SLIDE_BARS: Partial<Record<Style, readonly number[]>> = { drill: [0, 1, 2, 3], trap: [1, 3] };
/** Velocities of a bass: on the downbeat, elsewhere. */
const DOWNBEAT_VELOCITY = 0.9;
const OFFBEAT_VELOCITY = 0.8;

/** What decides a bass line. */
export interface BassInput {
  rule: BassRule;
  chords: readonly PlacedChord[];
  /** Where the pattern's kick hits (1/16 steps from its start): the bass follows them in the styles that do. */
  kickSteps: readonly number[];
  seed: number;
  label: string;
  /** 1 to 5: the busier sections play the busier figures. */
  energy: number;
  style: Style;
  /** The style's bass sound and name. */
  profile: StyleProfile;
}

const keyAtOrAbove = (pitchClass: number, low: number): number => low + mod12(pitchClass - low);

/** The chord's root (or slash bass) as a key at or above `low`. */
const rootKeyOf = (chord: ChordSymbol, low: number): number => keyAtOrAbove(bassPitchClass(chord), low);

/** The chord's fifth, a fifth above its root key unless that passes the top of the range (then a fourth below). */
function fifthKeyOf(chord: ChordSymbol, low: number, ceiling: number): number {
  const root = rootKeyOf(chord, low);
  return root + 7 <= ceiling ? root + 7 : root - 5;
}

/** Whether the chord has a perfect fifth above its root (a diminished chord does not). */
const hasPerfectFifth = (chord: ChordSymbol): boolean => chordPitchClasses(chord).includes(mod12(chord.root + 7));

/** The steps where the pattern's notes start: the kick's hits, plus the start of every chord (the bass changes with it). */
function hitsFor(chords: readonly PlacedChord[], kickSteps: readonly number[]): number[] {
  const hits = new Set<number>(kickSteps.filter((step) => step < PATTERN_STEPS));
  for (const placed of chords) {
    const hasKickThere = [...hits].some((hit) => Math.abs(hit - placed.step) < 1);
    if (!hasKickThere) hits.add(placed.step);
  }
  return [...hits].sort((a, b) => a - b);
}

/** The step the chord holding `step` ends at. */
function chordEndAt(chords: readonly PlacedChord[], step: number): number {
  const found = chords.find((entry) => step >= entry.step && step < entry.step + entry.length);
  return found ? found.step + found.length : PATTERN_STEPS;
}

/** An 808 that follows the kick: the chord's root on every hit, held to the next one, a slide at the end of the phrase. */
function eightOhEight(input: BassInput, random: Rng): BeatNote[] {
  const hits = hitsFor(input.chords, input.kickSteps);
  const notes: BeatNote[] = [];
  hits.forEach((step, index) => {
    const end = Math.min(hits[index + 1] ?? PATTERN_STEPS, chordEndAt(input.chords, step));
    const chord = chordAtStep(input.chords, step);
    const isDownbeat = step % STEPS_PER_BAR === 0;
    notes.push({
      step,
      len: Math.max(1, Math.min(MAX_808_STEPS, end - step)),
      key: rootKeyOf(chord, LOW_808),
      vel: isDownbeat ? DOWNBEAT_VELOCITY : OFFBEAT_VELOCITY,
    });
  });
  for (const bar of SLIDE_BARS[input.style] ?? [3]) addSlide(notes, bar, input.chords, random);
  return notes.sort((a, b) => a.step - b.step);
}

/**
 * Slides the last note of a bar into the chord's fifth above, its octave above or its fifth below, whichever stays between
 * C1 and E2: a second note that starts half a step before the first ends. A bar whose note has nowhere to go keeps it.
 */
function addSlide(notes: BeatNote[], bar: number, chords: readonly PlacedChord[], random: Rng): void {
  const inBar = notes.filter((note) => note.step >= bar * STEPS_PER_BAR && note.step < (bar + 1) * STEPS_PER_BAR);
  const last = inBar[inBar.length - 1];
  if (!last || (last.len ?? 1) < 3 || last.key === undefined) return;
  const from = last.key;
  const chord = chordAtStep(chords, last.step);
  const targets = hasPerfectFifth(chord) ? [from + 7, from + 12, from - 5] : [from + 12];
  const fits = targets.filter((target) => target >= MIN_808_SLIDE && target <= MAX_808);
  if (fits.length === 0) return;
  const key = random.pick(fits);
  const length = last.len ?? 1;
  const at = last.step + Math.max(1, length - SLIDE_LEAD_STEPS);
  notes.push({ step: at, len: last.step + length - at, key, vel: 0.85 });
  last.len = at - last.step + 0.5;
}

/** Now and then a bass hit that is not on a downbeat plays the chord's fifth or its octave instead of the root. */
const VARIED_HIT_CHANCE = 0.35;
const FIFTH_SHARE_OF_VARIED = 0.6;

/** The key of a bass hit on the kick: the root, or sometimes (off the downbeat) the fifth or the octave above it. */
function keyOnKick(chord: ChordSymbol, isDownbeat: boolean, random: Rng): number {
  const root = rootKeyOf(chord, LOW_BASS);
  if (isDownbeat || !random.chance(VARIED_HIT_CHANCE)) return root;
  if (hasPerfectFifth(chord) && random.chance(FIFTH_SHARE_OF_VARIED)) return fifthKeyOf(chord, LOW_BASS, FIFTH_CEILING);
  return root + 12 <= OCTAVE_CEILING ? root + 12 : root;
}

/** The longest a bass hit on the kick lasts (steps): it stops short of the next hit so each one is heard. */
const MAX_KICK_BASS_STEPS = 6;

/** A bass that plays on the kick hits: the root, now and then the fifth or octave on the hits between the downbeats. */
function subOnKick(input: BassInput, random: Rng): BeatNote[] {
  const hits = hitsFor(input.chords, input.kickSteps);
  return hits.map((step, index) => {
    const end = Math.min(hits[index + 1] ?? PATTERN_STEPS, chordEndAt(input.chords, step));
    const isDownbeat = step % STEPS_PER_BAR === 0;
    return {
      step,
      len: Math.max(0.5, Math.min(MAX_KICK_BASS_STEPS, end - step - 0.25)),
      key: keyOnKick(chordAtStep(input.chords, step), isDownbeat, random),
      vel: isDownbeat ? DOWNBEAT_VELOCITY : OFFBEAT_VELOCITY,
    };
  });
}

/** Notes from the harmony module's line writer, whose times are already steps (a bar is 16, a beat 4). */
function fromHarmonyLine(
  chords: readonly PlacedChord[],
  style: 'walking' | 'root-fifth',
  seed: number,
  low: number,
): BeatNote[] {
  const line = makeBassline(
    chords.map((entry) => ({ tick: entry.step, length: entry.length, chord: entry.chord })),
    { style, bar: STEPS_PER_BAR, beat: 4, end: PATTERN_STEPS, low, seed },
  );
  return line.map((note) => ({ step: note.tick, len: note.length, key: note.key, vel: note.velocity }));
}

/** Rolling 16ths: every step but the kick's, an octave on the last 16th of each beat; thinner when the section is quiet. */
function rolling(input: BassInput): BeatNote[] {
  const busy = input.energy >= 4;
  const steps = busy ? [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15] : [2, 3, 6, 7, 10, 11, 14, 15];
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < PATTERN_STEPS / STEPS_PER_BAR; bar++) {
    for (const inBar of steps) {
      const step = bar * STEPS_PER_BAR + inBar;
      const root = rootKeyOf(chordAtStep(input.chords, step), LOW_BASS);
      const isOctave = inBar % 4 === 3;
      notes.push({
        step,
        len: 0.8,
        key: isOctave && root + 12 <= OCTAVE_CEILING ? root + 12 : root,
        vel: isOctave ? OFFBEAT_VELOCITY : 0.75,
      });
    }
  }
  return notes;
}

/** The offbeat bass: the 8th between each pair of kicks, on the chord's root; an octave up at the end of the second and fourth bar. */
function offbeat(input: BassInput): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let beat = 0; beat < PATTERN_STEPS / 4; beat++) {
    const step = beat * 4 + 2;
    const root = rootKeyOf(chordAtStep(input.chords, step), LOW_BASS);
    const isLiftBeat = beat % 8 === 7 && root + 12 <= OCTAVE_CEILING;
    notes.push({ step, len: 1.5, key: isLiftBeat ? root + 12 : root, vel: OFFBEAT_VELOCITY });
  }
  return notes;
}

/** Tech house grooves: [step, length, semitones above the root] per bar. */
const GROOVES: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [2, 1, 0],
    [3, 0.75, 0],
    [6, 1.5, 0],
    [10, 1, 0],
    [11, 0.75, 12],
    [14, 1, 7],
  ],
  [
    [1, 1, 0],
    [2, 1, 0],
    [6, 1.5, 0],
    [9, 1, 0],
    [10, 0.75, 12],
    [13, 1, 7],
    [14, 1, 0],
  ],
  [
    [3, 1, 0],
    [6, 1, 7],
    [7, 0.75, 0],
    [10, 1.5, 0],
    [14, 1, 12],
  ],
];

/** A syncopated groove of the same few hits every bar, a different one for each seed. */
function groove(input: BassInput, random: Rng): BeatNote[] {
  const hits = random.pick(GROOVES);
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < PATTERN_STEPS / STEPS_PER_BAR; bar++) {
    for (const [inBar, len, up] of hits) {
      const step = bar * STEPS_PER_BAR + inBar;
      const root = rootKeyOf(chordAtStep(input.chords, step), LOW_BASS);
      const key = root + up <= OCTAVE_CEILING ? root + up : root;
      notes.push({ step, len, key, vel: 0.8 });
    }
  }
  return notes;
}

/** Long roots: one held through most of the bar and a short one that pushes into the next. */
function longSub(input: BassInput): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < PATTERN_STEPS / STEPS_PER_BAR; bar++) {
    const step = bar * STEPS_PER_BAR;
    const chord = chordAtStep(input.chords, step);
    const root = rootKeyOf(chord, LOW_BASS);
    notes.push({ step, len: 12, key: root, vel: 0.88 });
    const nextChord = chordAtStep(input.chords, (step + STEPS_PER_BAR) % PATTERN_STEPS);
    const pushes = !sameRoot(chord, nextChord);
    notes.push({ step: step + 12, len: 4, key: pushes ? rootKeyOf(nextChord, LOW_BASS) : root, vel: 0.8 });
  }
  return notes;
}

const sameRoot = (a: ChordSymbol, b: ChordSymbol): boolean => mod12(a.root) === mod12(b.root);

/** Dubstep: a sub on the roots, held under the half-time groove, and a growl that answers the kick and snare. */
function dubstep(input: BassInput): BeatTrack[] {
  const sub: BeatNote[] = [];
  const growl: BeatNote[] = [];
  const evenBar: readonly (readonly [number, number, number])[] = [
    [0, 6, 0],
    [6, 1.5, 0],
    [8, 3, 0],
    [12, 2, 7],
  ];
  const oddBar: readonly (readonly [number, number, number])[] = [
    [0, 4, 0],
    [4, 2, 0],
    [8, 2, 0],
    [10, 2, 7],
    [12, 4, 12],
  ];
  for (let bar = 0; bar < PATTERN_STEPS / STEPS_PER_BAR; bar++) {
    const start = bar * STEPS_PER_BAR;
    const root808 = rootKeyOf(chordAtStep(input.chords, start), LOW_808);
    sub.push({ step: start, len: 8, key: root808, vel: 0.9 }, { step: start + 8, len: 8, key: root808, vel: 0.9 });
    const rootBass = rootKeyOf(chordAtStep(input.chords, start), LOW_BASS);
    for (const [inBar, len, up] of bar % 2 === 0 ? evenBar : oddBar) {
      growl.push({
        step: start + inBar,
        len,
        key: rootBass + up <= OCTAVE_CEILING ? rootBass + up : rootBass,
        vel: 0.9,
      });
    }
  }
  return [
    { name: 'Sub', sound: '808', notes: sub },
    { name: input.profile.bassName, sound: input.profile.bassSound, notes: growl },
  ];
}

/** A reese on the two-step: the root on each kick hit, held until the next. */
function reese(input: BassInput): BeatNote[] {
  const hits = hitsFor(input.chords, input.kickSteps);
  return hits.map((step, index) => {
    const end = Math.min(hits[index + 1] ?? PATTERN_STEPS, chordEndAt(input.chords, step));
    return {
      step,
      len: Math.max(1, end - step - 0.5),
      key: rootKeyOf(chordAtStep(input.chords, step), LOW_BASS),
      vel: 0.85,
    };
  });
}

/** The bass track or tracks of a pattern. */
export function songBass(input: BassInput): BeatTrack[] {
  const random = streamFor(input.seed, `bass:${input.label}`);
  const { profile } = input;
  const one = (notes: BeatNote[], extra: Partial<BeatTrack> = {}): BeatTrack[] => [
    { name: profile.bassName, sound: profile.bassSound, notes, ...extra },
  ];
  switch (input.rule) {
    case 'eight08':
      return one(eightOhEight(input, random), { params: { glide: 0.09, decay: 2.2 } });
    case 'sub-kick':
      return one(subOnKick(input, random));
    case 'walking':
      return one(fromHarmonyLine(input.chords, 'walking', input.seed, 31));
    case 'pop':
      return one(fromHarmonyLine(input.chords, 'root-fifth', input.seed, LOW_BASS - 2));
    case 'rolling':
      return one(rolling(input));
    case 'offbeat':
      return one(offbeat(input));
    case 'groove':
      return one(groove(input, random));
    case 'long-sub':
      return one(longSub(input));
    case 'growl':
      return dubstep(input);
    case 'reese':
      return one(reese(input));
  }
}
