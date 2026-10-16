/**
 * Finding sample hashes inside data. A blob is "in use" when any stored value mentions its SHA-256, so
 * the finder does not know the shape of what it reads: it takes every 64-hex-digit run in every string
 * (and every object key) of a plain value. Over-finding only keeps extra bytes, which is the safe
 * direction; the one thing it must never do is miss a hash, whatever the project schema grows into.
 *
 * Results are remembered per object (WeakMap), and Immer shares the objects an edit didn't touch, so
 * looking at a big project again after one edit costs the changed branch, not the whole tree.
 */

const HEX64 = /[0-9a-fA-F]{64}/g;
const EMPTY: readonly string[] = Object.freeze([]);
const memo = new WeakMap<object, readonly string[]>();

function inString(s: string, out: Set<string>): void {
  if (s.length < 64) return;
  HEX64.lastIndex = 0;
  for (let m = HEX64.exec(s); m; m = HEX64.exec(s)) out.add(m[0].toLowerCase());
}

function walk(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') return inString(node, out);
  if (typeof node !== 'object' || node === null) return;
  const proto = Object.getPrototypeOf(node) as object | null;
  const isArray = Array.isArray(node);
  // Only plain data: handles, typed arrays and class instances hold no hashes of ours.
  if (!isArray && proto !== Object.prototype && proto !== null) return;
  const cached = memo.get(node);
  if (cached) {
    for (const h of cached) out.add(h);
    return;
  }
  const mine = new Set<string>();
  if (isArray) for (const v of node as unknown[]) walk(v, mine);
  else
    for (const [k, v] of Object.entries(node)) {
      inString(k, mine);
      walk(v, mine);
    }
  // Frozen (Immer) data never changes under the cache; a plain object could, so only those are kept.
  if (Object.isFrozen(node)) memo.set(node, mine.size === 0 ? EMPTY : [...mine]);
  for (const h of mine) out.add(h);
}

/** Every sample hash (lowercase) mentioned anywhere in `value`, added to `into` when given. */
export function collectHashes(value: unknown, into: Set<string> = new Set()): Set<string> {
  walk(value, into);
  return into;
}
