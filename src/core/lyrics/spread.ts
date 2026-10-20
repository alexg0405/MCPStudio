/**
 * Spreading parsed lyrics over time: onto slots (the notes of a melody, or the notes a singer sang) or evenly over bars.
 * The result is plain words ready for `placeLyricWords`; nothing here touches the project.
 */
import type { Tick } from '../model/types';
import type { Slot } from './slots';
import type { Syllable } from './parse';

/** A word or syllable with its place, as the lyrics lane stores it. */
export interface PlacedWord {
  tick: Tick;
  length: Tick;
  text: string;
  /** The line it belongs to (numbered from the `firstLine` given). */
  line: number;
  continues?: true;
}

/** What `spreadOnSlots` did. */
export interface Spread {
  words: PlacedWord[];
  /** Syllables that found no slot (more words than notes): they are not placed. */
  leftover: number;
  /** Slots that got no syllable (more notes than words). */
  emptySlots: number;
}

const placed = (syllable: Syllable, tick: Tick, length: Tick, line: number): PlacedWord => ({
  tick,
  length: Math.max(1, length),
  text: syllable.text,
  line,
  ...(syllable.continues ? { continues: true as const } : {}),
});

/**
 * One syllable per slot, in order: the first syllable of the first line on the first slot, and so on across lines (a line
 * break does not skip a note). Syllables beyond the last slot are left out and counted.
 */
export function spreadOnSlots(lines: readonly (readonly Syllable[])[], slots: readonly Slot[], firstLine = 0): Spread {
  const words: PlacedWord[] = [];
  let next = 0;
  let leftover = 0;
  for (const [lineIndex, line] of lines.entries()) {
    for (const syllable of line) {
      const slot = slots[next];
      if (!slot) {
        leftover++;
        continue;
      }
      words.push(placed(syllable, slot.tick, slot.length, firstLine + lineIndex));
      next++;
    }
  }
  return { words, leftover, emptySlots: Math.max(0, slots.length - next) };
}

/** What `spreadEvenly` needs. */
export interface EvenOptions {
  /** Where the lyrics start (ticks). */
  fromTick: Tick;
  /** Where they end: all syllables are spread evenly between the two. Without it each line takes `barsPerLine` bars. */
  toTick?: Tick;
  barTicks: Tick;
  /** Bars one line takes when there is no `toTick` (default 1). */
  barsPerLine?: number;
  firstLine?: number;
}

/** Cuts [from, to) into `count` equal parts (whole ticks, the last one takes the rounding). */
function equalParts(from: Tick, to: Tick, count: number): Array<[Tick, Tick]> {
  const parts: Array<[Tick, Tick]> = [];
  for (let i = 0; i < count; i++) {
    const start = from + Math.round(((to - from) * i) / count);
    const end = from + Math.round(((to - from) * (i + 1)) / count);
    parts.push([start, Math.max(start + 1, end)]);
  }
  return parts;
}

/** Syllables spread evenly: over [fromTick, toTick) when given, else one line to each `barsPerLine` bars from fromTick. */
export function spreadEvenly(lines: readonly (readonly Syllable[])[], options: EvenOptions): PlacedWord[] {
  const firstLine = options.firstLine ?? 0;
  const out: PlacedWord[] = [];
  if (options.toTick !== undefined && options.toTick > options.fromTick) {
    const all = lines.flatMap((line, lineIndex) => line.map((syllable) => ({ syllable, lineIndex })));
    const parts = equalParts(options.fromTick, options.toTick, all.length);
    all.forEach(({ syllable, lineIndex }, i) => {
      const [start, end] = parts[i] as [Tick, Tick];
      out.push(placed(syllable, start, end - start, firstLine + lineIndex));
    });
    return out;
  }
  const lineTicks = Math.max(1, Math.round((options.barsPerLine ?? 1) * options.barTicks));
  for (const [lineIndex, line] of lines.entries()) {
    const from = options.fromTick + lineIndex * lineTicks;
    const parts = equalParts(from, from + lineTicks, line.length);
    line.forEach((syllable, i) => {
      const [start, end] = parts[i] as [Tick, Tick];
      out.push(placed(syllable, start, end - start, firstLine + lineIndex));
    });
  }
  return out;
}
