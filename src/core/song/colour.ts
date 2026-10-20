/**
 * What fills the loud sections on top of the lead: an arpeggio of the chord (dance styles), or a counter-melody that plays
 * in the rests of the lead and holds chord tones under it (the other styles). Both use only the tones of the chord under
 * them, so they cannot clash with it.
 */
import { chordPitchClasses, mod12, type ChordSymbol } from '../harmony/chord';
import type { BeatNote } from '../beat/spec';
import { chordAtStep, PATTERN_STEPS } from './harmony';
import type { StyleProfile } from './profiles';
import { streamFor } from './rng';
import type { PlacedChord } from './types';

/** The arpeggio's register (MIDI keys): above the pads, a little under the lead. */
const ARP_LOW = 62;
const ARP_HIGH = 79;
/** Orders the arpeggio visits the chord's tones in (indexes into its tones, going up the keys). */
const ARP_ORDERS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 2, 1],
  [0, 2, 1, 3],
  [0, 1, 2, 1],
  [3, 2, 1, 0, 1, 2],
];

/** The chord's tones as keys from `low` up to `high`, ascending. */
function tonesBetween(chord: ChordSymbol, low: number, high: number): number[] {
  const pitchClasses = new Set(chordPitchClasses(chord));
  const keys: number[] = [];
  for (let key = low; key <= high; key++) if (pitchClasses.has(mod12(key))) keys.push(key);
  return keys;
}

/** An arpeggio of the chord under it, a note every `profile.arp.every` steps, the first of each beat accented. */
export function songArp(chords: readonly PlacedChord[], profile: StyleProfile, seed: number, strength: number): BeatNote[] {
  const { every } = profile.arp;
  const order = streamFor(seed, 'arp').pick(ARP_ORDERS);
  const notes: BeatNote[] = [];
  for (let step = 0, i = 0; step < PATTERN_STEPS; step += every, i++) {
    const keys = tonesBetween(chordAtStep(chords, step), ARP_LOW, ARP_HIGH);
    const pick = order[i % order.length] as number;
    const key = keys[pick % keys.length] as number;
    const accent = step % 4 === 0 ? 1 : 0.82;
    notes.push({ step, len: every === 1 ? 0.75 : 1.5, key, vel: Math.round(strength * accent * 1000) / 1000 });
  }
  return notes;
}

/** The counter-melody's register: under the lead, from the middle of the pads' hand up. */
const COUNTER_LOW = 55;
const COUNTER_HIGH = 72;
/** A counter note lasts this many steps, and at most one starts in this many (it answers the lead, it does not compete). */
const COUNTER_NOTE_STEPS = 3;
const MIN_SPACING_STEPS = 4;
/** The counter stays at least this far (semitones) under the lead note that sounds with it. */
const MIN_BELOW_LEAD = 3;
/** How badly an interval under the lead sounds, by semitones mod 12: thirds and sixths best, a fourth fine, fifths and octaves doubled, the rest rough. */
const INTERVAL_COST: Record<number, number> = { 3: 0, 4: 0, 8: 0, 9: 0, 5: 1, 0: 5, 7: 5 };
const ROUGH_INTERVAL_COST = 8;
/** A line that repeats its last note stands still: it costs as much as a move of this many semitones. */
const REPEAT_COST = 5;

/** The lead note sounding at a step, or the last one before it when the lead rests. */
function leadAt(sorted: readonly BeatNote[], step: number): BeatNote | undefined {
  return [...sorted].reverse().find((note) => note.step <= step);
}

/** Whether the lead starts a note at this step or the step after. */
const leadStartsNear = (sorted: readonly BeatNote[], step: number): boolean =>
  sorted.some((note) => Math.abs(note.step - step) < 1 || Math.abs(note.step - (step + 1)) < 1);

/** The chord tone under the lead that sounds best with it and moves least from the counter's last note. */
function counterKey(chord: ChordSymbol, leadKey: number, previous: number | null): number | null {
  const keys = tonesBetween(chord, COUNTER_LOW, COUNTER_HIGH).filter((key) => leadKey - key >= MIN_BELOW_LEAD);
  const around = previous ?? (COUNTER_LOW + COUNTER_HIGH) / 2;
  let best: number | null = null;
  let bestCost = Infinity;
  for (const key of keys) {
    const repeat = key === previous ? REPEAT_COST : 0;
    const cost = (INTERVAL_COST[mod12(leadKey - key)] ?? ROUGH_INTERVAL_COST) * 3 + Math.abs(key - around) + repeat;
    if (cost < bestCost) {
      best = key;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * A counter-melody: a second line of chord tones under the lead that starts where the lead does not, a third or sixth below
 * the note it sounds against, moving as little as it can.
 */
export function songCounter(chords: readonly PlacedChord[], lead: readonly BeatNote[], strength: number): BeatNote[] {
  const sorted = [...lead].sort((a, b) => a.step - b.step);
  const notes: BeatNote[] = [];
  let previousKey: number | null = null;
  let lastStart = -MIN_SPACING_STEPS;
  for (let step = 0; step < PATTERN_STEPS; step += 2) {
    if (step - lastStart < MIN_SPACING_STEPS || leadStartsNear(sorted, step)) continue;
    const sounding = leadAt(sorted, step);
    if (sounding?.key === undefined) continue;
    const key = counterKey(chordAtStep(chords, step), sounding.key, previousKey);
    if (key === null) continue;
    notes.push({ step, len: COUNTER_NOTE_STEPS, key, vel: Math.round(strength * 1000) / 1000 });
    previousKey = key;
    lastStart = step;
  }
  return notes;
}
