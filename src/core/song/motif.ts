/**
 * Motifs: the short idea a melody is built from. A motif is a rhythm (where notes start and how long they last in a
 * two-bar phrase) with a contour (how far each note moves from the one before, in steps of the scale). It has no key and no
 * chords yet: `melody.ts` puts it on the harmony. Here are the rhythms each style family likes, the walk that makes a
 * contour, and the changes that turn one statement into a variation (move a hit, drop one, split a long note, invert).
 */
import type { RhythmFamily } from './profiles';
import { STEPS_PER_BAR } from './harmony';
import type { Rng } from './rng';

/** One note of a motif: its step in the phrase, its length in steps and its move in scale steps from the note before. */
export interface MotifNote {
  step: number;
  len: number;
  move: number;
}

/** A two-bar rhythm cell is sixteen characters a bar: x is a note start. */
type Cell = string;

/** Rhythm cells for a verse, by family: busy enough to carry words-less melody, with the syncopations the family likes. */
const VERSE_CELLS: Record<RhythmFamily, readonly Cell[]> = {
  plain: ['x..x..x...x.x...', 'x.....x.x.x.....', 'x...x...x..x.x..', 'x..xx..x....x...', 'x.x.x.x.x...x...', 'x..x....x..x..x.', 'x.x...x.x.x.x...'],
  bounce: ['x.....x...x.....', 'x..x....x..x....', 'x.x...x.x.x.....', 'x....x..x.....x.', 'x..x..x...x.....', '..x...x...x...x.'],
  laid: ['x..x..x.....x...', 'x....x..x..x....', '..x..x...x..x...', 'x..x....x.....x.', 'x.x.....x..x....', '..x...x.x...x...'],
  driving: ['x.x.xx..x.x.xx..', 'x.xx.x.x.xx.x.x.', 'x..x.xx.x..x.xx.', 'x.x..x.xx.x.x...', 'xx.x.x.xx.x.x.x.'],
};

/** Rhythm cells for a hook: fewer, longer, more repeated notes, so it is easy to remember. */
const HOOK_CELLS: Record<RhythmFamily, readonly Cell[]> = {
  plain: ['x..x..x.........', 'x.....x.x.......', 'x..x....x..x....', 'x.x.....x.......', 'x...x..x........'],
  bounce: ['x..x....x.......', 'x.....x...x.....', 'x.x.....x.......', 'x....x..x.......'],
  laid: ['x..x....x.......', 'x...x.....x.....', '..x...x.x.......', 'x.....x...x.....'],
  driving: ['x.x.x.x.x.......', 'x.xx....x.x.....', 'x..x..x.x.......', 'x.x...x.x.x.....'],
};

/** The longest a note lasts in each family, in steps (driving melodies are short and punchy). */
const MAX_NOTE_STEPS: Record<RhythmFamily, number> = { plain: 8, bounce: 6, laid: 8, driving: 3 };

/** Moves in scale steps and how often each is made: mostly steps, some skips, rare leaps. */
function movesFor(repeatWeight: number): readonly { item: number; weight: number }[] {
  return [
    { item: -3, weight: 3 },
    { item: -2, weight: 9 },
    { item: -1, weight: 26 },
    { item: 0, weight: repeatWeight },
    { item: 1, weight: 26 },
    { item: 2, weight: 9 },
    { item: 3, weight: 3 },
  ];
}

/** How often a note repeats the one before: a verse line does it now and then, a hook does it rarely (it must keep moving to stick). */
const REPEAT_WEIGHT: Record<'verse' | 'hook', number> = { verse: 12, hook: 4 };

const MOVES = movesFor(REPEAT_WEIGHT.verse);

/** The onsets of a cell: the steps of its x marks. */
const onsetsOf = (cell: Cell): number[] => [...cell].flatMap((mark, step) => (mark === 'x' ? [step] : []));

/** How much of the gap to the next note a note fills: the rest is air, which gives the line a pulse and the counter-melody room. */
const GATE = 0.75;

/** Notes of a two-bar rhythm: each lasts until the next one starts (less the gate's air), at most `cap` steps. */
function rhythmNotes(cells: readonly [Cell, Cell], cap: number): { step: number; len: number }[] {
  const steps = [...onsetsOf(cells[0]), ...onsetsOf(cells[1]).map((step) => step + STEPS_PER_BAR)];
  const end = 2 * STEPS_PER_BAR;
  return steps.map((step, index) => {
    const gap = (steps[index + 1] ?? end) - step;
    return { step, len: Math.max(1, Math.min(cap, Math.round(gap * GATE))) };
  });
}

/** A contour: `count` moves that rise toward the middle of the phrase and fall back (or the other way round). */
function arch(count: number, random: Rng, moves: typeof MOVES): number[] {
  const rises = random.chance(0.6);
  return Array.from({ length: count }, (_, index) => {
    const move = random.weighted(moves);
    const inFirstHalf = index < count / 2;
    // A nudge toward the arch: a note in the rising half is a little more likely to go up.
    if (index > 0 && move !== 0 && random.chance(0.3)) return Math.abs(move) * (inFirstHalf === rises ? 1 : -1);
    return move;
  });
}

/** The kind of motif: a verse's phrase or a hook. */
export type MotifKind = 'verse' | 'hook';

/** Makes the two-bar motif of a song: a rhythm from the family's cells (the second bar a variation of the first) and a contour. */
export function makeMotif(kind: MotifKind, family: RhythmFamily, random: Rng): MotifNote[] {
  const cells = kind === 'hook' ? HOOK_CELLS[family] : VERSE_CELLS[family];
  const first = random.pick(cells);
  const second = random.chance(0.45) ? first : random.pick(cells);
  const rhythm = rhythmNotes([first, second], MAX_NOTE_STEPS[family]);
  const moves = contourFor(rhythm.filter((note) => note.step < STEPS_PER_BAR).length, first === second, rhythm.length, random, kind);
  return rhythm.map((note, index) => ({ ...note, move: moves[index] as number }));
}

/**
 * The contour of a two-bar motif. When the second bar has the first bar's rhythm it also has its contour, with the last
 * move changed (a repeat that answers); otherwise the second bar gets a contour of its own.
 */
function contourFor(firstBarNotes: number, sameRhythm: boolean, total: number, random: Rng, kind: MotifKind): number[] {
  const moves = movesFor(REPEAT_WEIGHT[kind]);
  const first = arch(firstBarNotes, random, moves);
  if (!sameRhythm) return [...first, ...arch(total - firstBarNotes, random, moves)];
  const repeat = [...first];
  if (repeat.length > 1 && random.chance(0.7)) repeat[repeat.length - 1] = random.weighted(moves);
  return [...first, ...repeat];
}

/** A copy of the motif, moved `steps` later in the pattern. */
export const shifted = (motif: readonly MotifNote[], steps: number): MotifNote[] =>
  motif.map((note) => ({ ...note, step: note.step + steps }));

/** The motif turned upside down: every move goes the other way (the first note's move too). */
export const inverted = (motif: readonly MotifNote[]): MotifNote[] => motif.map((note) => ({ ...note, move: -note.move }));

/** The same motif a number of scale steps higher or lower (only its first note moves; the rest follow it). */
export function transposed(motif: readonly MotifNote[], scaleSteps: number): MotifNote[] {
  return motif.map((note, index) => (index === 0 ? { ...note, move: note.move + scaleSteps } : { ...note }));
}

/** Keeps the notes at even positions in the list and gives their time to the notes before (a thinner version). */
export function thinned(motif: readonly MotifNote[]): MotifNote[] {
  const kept: MotifNote[] = [];
  let carried = 0;
  motif.forEach((note, index) => {
    if (index === 0 || index % 2 === 0) {
      kept.push({ ...note, move: note.move + carried });
      carried = 0;
      return;
    }
    carried += note.move;
    const last = kept[kept.length - 1];
    if (last) last.len = Math.max(last.len, note.step + note.len - last.step);
  });
  return kept;
}

/**
 * A busier version: each note of three steps or more splits, its second half stepping to a neighbour in the scale and the
 * next note starting from where it would have (so the line returns to its old notes).
 */
export function ornamented(motif: readonly MotifNote[], random: Rng): MotifNote[] {
  const out: MotifNote[] = [];
  let owed = 0;
  motif.forEach((note) => {
    const move = note.move - owed;
    owed = 0;
    if (note.len < 3 || !random.chance(0.7)) {
      out.push({ ...note, move });
      return;
    }
    const half = Math.max(1, Math.floor(note.len / 2));
    const neighbour = random.chance(0.5) ? 1 : -1;
    out.push({ step: note.step, len: note.len - half, move });
    out.push({ step: note.step + note.len - half, len: half, move: neighbour });
    owed = neighbour;
  });
  return out;
}

/** The motif with one note (not the first) moved a step earlier or later, which syncopates it. */
export function syncopated(motif: readonly MotifNote[], random: Rng): MotifNote[] {
  if (motif.length < 3) return motif.map((note) => ({ ...note }));
  const index = 1 + random.int(motif.length - 1);
  const direction = random.chance(0.5) ? 1 : -1;
  return motif.map((note, at) => {
    if (at !== index) return { ...note };
    const previous = motif[at - 1] as MotifNote;
    const next = motif[at + 1];
    const step = note.step + direction;
    const isFree = step > previous.step && (!next || step < next.step);
    return isFree ? { ...note, step, len: Math.max(1, note.len - direction) } : { ...note };
  });
}

/** The motif's own contour with its last two moves changed (a hook's second half answers its first). */
export function answered(motif: readonly MotifNote[], random: Rng): MotifNote[] {
  const out = motif.map((note) => ({ ...note }));
  for (const note of out.slice(-2)) note.move = random.weighted(MOVES);
  return out;
}
