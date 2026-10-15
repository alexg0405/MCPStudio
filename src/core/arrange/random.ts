/**
 * Seeded randomness for the arranger (core can't use the SDK's): mulberry32 and a string hash, so a
 * variation made twice from the same notes comes out the same.
 */

/** A uniform [0, 1) generator from a 32-bit seed (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32-bit. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A value in [−amount, amount) from the generator. */
export const jitter = (rand: () => number, amount: number): number => (rand() * 2 - 1) * amount;
