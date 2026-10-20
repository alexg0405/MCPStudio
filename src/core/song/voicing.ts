/**
 * Voicing a pattern's chords for a pad or keys: the voice leading of `core/harmony/voicing` (each chord moves as little as
 * possible from the one before) with one more rule, the one a music teacher would add: the outer voices must not move in
 * parallel fifths or octaves. A loop is voiced as a loop, so its last chord leads into its first.
 */
import type { ChordSymbol } from '../harmony/chord';
import { bassKeyFor, voiceMovement, voicingCandidates, type Candidate, type Spread } from '../harmony/voicing';

/** Where the bass of a chord sits when the outer voices are checked: the octave from C2. */
const BASS_LOW = 36;
/** What a parallel fifth or octave costs in semitones of movement: more than any voicing change is worth. */
const OUTER_PARALLEL_COST = 12;
const INNER_PARALLEL_COST = 3;
/** The top voice moving by leap is a little worse than the same movement spread over the inner voices. */
const TOP_LEAP_COST = 0.4;
/** A pull toward the middle of the hand, so equal choices go to the voicing nearest it (semitones of cost per semitone). */
const CENTRE_PULL = 0.15;

const intervalClass = (semitones: number): number => ((semitones % 12) + 12) % 12;
const isPerfect = (semitones: number): boolean => intervalClass(semitones) === 0 || intervalClass(semitones) === 7;

/**
 * Whether two voices, a lower and a higher one, move in parallel perfect intervals from one chord to the next: both go the
 * same way, and the gap between them is a fifth (or a twelfth) before and after, or an octave before and after.
 */
export function isParallelPerfect(lowBefore: number, highBefore: number, lowAfter: number, highAfter: number): boolean {
  const before = highBefore - lowBefore;
  const after = highAfter - lowAfter;
  if (!isPerfect(before) || intervalClass(before) !== intervalClass(after)) return false;
  const lowMove = lowAfter - lowBefore;
  const highMove = highAfter - highBefore;
  return lowMove !== 0 && highMove !== 0 && Math.sign(lowMove) === Math.sign(highMove);
}

/** The lowest and highest keys of a voicing (an empty voicing has neither). */
function outerVoices(keys: readonly number[]): { low: number; high: number } {
  return { low: Math.min(...keys), high: Math.max(...keys) };
}

/** How many outer-voice parallels the move from one voicing to the next has (the voicing's own outer voices, and the bass note against its top). */
export function outerParallels(
  before: { keys: readonly number[]; chord: ChordSymbol },
  after: { keys: readonly number[]; chord: ChordSymbol },
): number {
  const a = outerVoices(before.keys);
  const b = outerVoices(after.keys);
  let count = isParallelPerfect(a.low, a.high, b.low, b.high) ? 1 : 0;
  const bassBefore = bassKeyFor(before.chord, BASS_LOW);
  const bassAfter = bassKeyFor(after.chord, BASS_LOW);
  if (isParallelPerfect(bassBefore, a.high, bassAfter, b.high)) count++;
  return count;
}

/** The cost of moving from one candidate voicing to the next: total movement, leaps in the top voice, parallels. */
function transitionCost(
  before: { candidate: Candidate; chord: ChordSymbol },
  after: { candidate: Candidate; chord: ChordSymbol },
): number {
  const keysBefore = before.candidate.keys;
  const keysAfter = after.candidate.keys;
  const topBefore = keysBefore[keysBefore.length - 1] as number;
  const topAfter = keysAfter[keysAfter.length - 1] as number;
  let cost = voiceMovement(keysBefore, keysAfter) + TOP_LEAP_COST * Math.abs(topAfter - topBefore);
  cost += OUTER_PARALLEL_COST * outerParallels({ keys: keysBefore, chord: before.chord }, { keys: keysAfter, chord: after.chord });
  const inner = Math.min(keysBefore.length, keysAfter.length);
  for (let low = 1; low < inner - 1; low++) {
    for (let high = low + 1; high < inner - 1; high++) {
      const parallel = isParallelPerfect(
        keysBefore[low] as number,
        keysBefore[high] as number,
        keysAfter[low] as number,
        keysAfter[high] as number,
      );
      if (parallel) cost += INNER_PARALLEL_COST;
    }
  }
  return cost;
}

const mean = (keys: readonly number[]): number => keys.reduce((sum, key) => sum + key, 0) / Math.max(1, keys.length);

/** The voicings of each chord to choose from; a chord with none gets its root alone. */
function candidatesOf(chords: readonly ChordSymbol[], center: number, spread: Spread): Candidate[][] {
  return chords.map((chord) => {
    const found = voicingCandidates(chord, { center, spread });
    return found.length > 0 ? found : [{ keys: [center + intervalClass(chord.root - center)], inversion: 0 }];
  });
}

/** The cheapest way through the candidates when the first chord is fixed to `start`, with the cost of looping back to it. */
function cheapestFrom(
  chords: readonly ChordSymbol[],
  sets: readonly Candidate[][],
  start: number,
  center: number,
): { cost: number; picks: number[] } {
  const pull = (candidate: Candidate) => Math.abs(mean(candidate.keys) - center) * CENTRE_PULL;
  const first = (sets[0] as Candidate[])[start] as Candidate;
  let costs: number[] = [pull(first)];
  const backs: number[][] = [[-1]];
  for (let i = 1; i < chords.length; i++) {
    const row: number[] = [];
    const back: number[] = [];
    const previousSet = i === 1 ? [first] : (sets[i - 1] as Candidate[]);
    for (const candidate of sets[i] as Candidate[]) {
      let best = Infinity;
      let argument = 0;
      previousSet.forEach((previous, index) => {
        const total =
          (costs[index] as number) +
          transitionCost(
            { candidate: previous, chord: chords[i - 1] as ChordSymbol },
            { candidate, chord: chords[i] as ChordSymbol },
          );
        if (total < best) {
          best = total;
          argument = index;
        }
      });
      row.push(best + pull(candidate));
      back.push(argument);
    }
    costs = row;
    backs.push(back);
  }
  const lastSet = chords.length === 1 ? [first] : (sets[chords.length - 1] as Candidate[]);
  let end = 0;
  let endCost = Infinity;
  lastSet.forEach((candidate, index) => {
    const wrap =
      chords.length > 1
        ? transitionCost(
            { candidate, chord: chords[chords.length - 1] as ChordSymbol },
            { candidate: first, chord: chords[0] as ChordSymbol },
          )
        : 0;
    const total = (costs[index] as number) + wrap;
    if (total < endCost) {
      endCost = total;
      end = index;
    }
  });
  const picks: number[] = new Array<number>(chords.length).fill(0);
  let at = end;
  for (let i = chords.length - 1; i >= 1; i--) {
    picks[i] = at;
    at = (backs[i] as number[])[at] as number;
  }
  picks[0] = start;
  return { cost: endCost, picks };
}

/**
 * The keys of each chord of a looping progression, ascending, around `center`: the voice-led choice that has the least
 * movement and no parallel fifths or octaves in the outer voices.
 */
export function voiceLoop(chords: readonly ChordSymbol[], center: number, spread: Spread = 'close'): number[][] {
  if (chords.length === 0) return [];
  const sets = candidatesOf(chords, center, spread);
  let best: { cost: number; picks: number[] } | null = null;
  for (let start = 0; start < (sets[0] as Candidate[]).length; start++) {
    const found = cheapestFrom(chords, sets, start, center);
    if (!best || found.cost < best.cost) best = found;
  }
  const picks = (best as { picks: number[] }).picks;
  return picks.map((pick, i) => [...(((sets[i] as Candidate[])[pick] as Candidate).keys)]);
}
