/**
 * Seeded randomness for the song generator: a numbered stream per purpose, so changing how one part is written (the bass,
 * say) never changes the notes of another (the melody), and the same seed always gives the same song.
 */
import { hashString, mulberry32 } from '../arrange/random';

/** A small random source with the few helpers the generator needs. */
export interface Rng {
  /** A number in [0, 1). */
  next(): number;
  /** A whole number from 0 to `count - 1`. */
  int(count: number): number;
  /** One of the items (at least one is required). */
  pick<T>(items: readonly T[]): T;
  /** True with this probability (0 to 1). */
  chance(probability: number): boolean;
  /** One of the items, each as likely as its weight says. */
  weighted<T>(items: readonly { item: T; weight: number }[]): T;
}

/** A random source from a 32-bit seed. */
export function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (count: number) => Math.min(count - 1, Math.floor(next() * count));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(items.length)] as T,
    chance: (probability) => next() < probability,
    weighted: <T>(items: readonly { item: T; weight: number }[]): T => {
      const total = items.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
      let left = next() * total;
      for (const entry of items) {
        left -= Math.max(0, entry.weight);
        if (left < 0) return entry.item;
      }
      return (items[items.length - 1] as { item: T; weight: number }).item;
    },
  };
}

/** An independent stream for one purpose ("melody:hook"): the same seed and label always give the same numbers. */
export function streamFor(seed: number, label: string): Rng {
  return makeRng((seed ^ hashString(label)) >>> 0);
}
