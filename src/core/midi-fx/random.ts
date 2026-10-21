/**
 * Repeatable "random" numbers for the MIDI effects. A draw is a hash of a seed and a few whole numbers (a note's identity, its
 * start, a step number), not a stream, so a note gets the same draw every time it is looked at: playing the song again, planning
 * it again after an edit or baking the effects all give the same notes, and editing one note never reshuffles the others.
 */

/** A 32-bit hash of a string (FNV-1a): turns a note's identity into a number for `draw`. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mixes one whole number into a running hash (the finalizer of MurmurHash3). */
function mix(hash: number, value: number): number {
  let h = Math.imul(hash ^ (value | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 1) that depends only on the seed and the three numbers given (the same inputs always give the same number). */
export function draw(seed: number, a: number, b = 0, c = 0): number {
  const hash = mix(mix(mix(mix(0x9e3779b9, seed), a), b), c);
  return hash / 4294967296;
}

/** The part of a tick position that matters to a draw: a thousandth of a tick keeps fractional starts apart. */
export function tickBits(tick: number): number {
  return Math.round(tick * 1000);
}
