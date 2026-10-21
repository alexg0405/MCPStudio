/** Note values and their lengths in ticks (a quarter note is 960), and the words a person uses for them. */
import type { Tick } from '../model/types';
import type { NoteValue } from './types';

const WHOLE_TICKS = 3840;

/** Every value the engraver writes as one symbol, longest first: whole to 64th, with one dot. */
export const NOTE_VALUES: ReadonlyArray<{ ticks: Tick; value: NoteValue }> = (() => {
  const out: Array<{ ticks: Tick; value: NoteValue }> = [];
  for (const base of [1, 2, 4, 8, 16, 32, 64] as const) {
    const plain = WHOLE_TICKS / base;
    out.push({ ticks: plain, value: { base, dots: 0 } });
    // A dotted 64th (90 ticks) is not a place a grid reaches, and a dotted whole is longer than a bar of 4/4.
    if (base !== 1 && base !== 64) out.push({ ticks: plain * 1.5, value: { base, dots: 1 } });
  }
  return out.sort((a, b) => b.ticks - a.ticks);
})();

const BY_TICKS = new Map(NOTE_VALUES.map((entry) => [entry.ticks, entry.value]));

/** The single note value that is exactly this long, or null when it takes several tied notes. */
export function valueOfTicks(ticks: Tick): NoteValue | null {
  return BY_TICKS.get(ticks) ?? null;
}

/** The length of a note value in ticks. */
export function ticksOfValue(value: NoteValue): Tick {
  const plain = WHOLE_TICKS / value.base;
  return value.dots === 1 ? plain * 1.5 : plain;
}

/**
 * Splits a length into the longest values that add up to it (greedy). Used when a span has no place inside it to split
 * at: a length that is not a multiple of the smallest value comes out as one 64th too long or short at most.
 */
export function greedyValues(ticks: Tick): NoteValue[] {
  const out: NoteValue[] = [];
  let left = ticks;
  for (const entry of NOTE_VALUES) {
    while (left >= entry.ticks) {
      out.push(entry.value);
      left -= entry.ticks;
    }
  }
  return out;
}

const BASE_NAMES: Record<NoteValue['base'], string> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: 'sixteenth',
  32: 'thirty-second',
  64: 'sixty-fourth',
};

/** "quarter note", "dotted eighth note". */
export function valueName(value: NoteValue): string {
  return `${value.dots ? 'dotted ' : ''}${BASE_NAMES[value.base]} note`;
}

/** "quarter rest", "dotted half rest". */
export function restName(value: NoteValue): string {
  return `${value.dots ? 'dotted ' : ''}${BASE_NAMES[value.base]} rest`;
}

/** How many flags or beams a value has: none for a quarter and longer, 1 for an eighth, 2 for a sixteenth... */
export function flagCount(value: NoteValue): number {
  return value.base >= 8 ? Math.log2(value.base) - 2 : 0;
}

/** The letter a value is written with in the compact text ("q" quarter), and the reverse. */
export const VALUE_LETTERS: Record<NoteValue['base'], string> = { 1: 'w', 2: 'h', 4: 'q', 8: 'e', 16: 's', 32: 't', 64: 'x' };
/** The value a compact-text letter stands for. */
export const LETTER_VALUES: Readonly<Record<string, NoteValue['base']>> = { w: 1, h: 2, q: 4, e: 8, s: 16, t: 32, x: 64 };
