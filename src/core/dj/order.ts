/**
 * Auto order for a DJ mix: songs that mix well follow each other (harmonic moves on the Camelot
 * wheel, close tempos) while the mix follows an energy shape (build, party, chill, peak time).
 * Greedy from every possible start, then improved with swaps and moves until nothing gets better;
 * pinned songs never leave their position. Deterministic (ties go to the input order).
 */
import type { TrackAnalysis } from './types';
import { HARMONIC_COST, harmonicMove, tempoCost, tempoMatch, trackEnergy } from './wheel';

/** The shape of energy a mix should follow from its first song to its last. */
export type EnergyShape = 'build' | 'party' | 'chill' | 'peak-time';
/** Every energy shape, for pickers. */
export const ENERGY_SHAPES: readonly EnergyShape[] = ['build', 'party', 'chill', 'peak-time'];

/** A song to order: its analysis, and whether it keeps its place. */
export interface OrderItem {
  analysis: TrackAnalysis;
  /** Keeps its position in the input order. */
  pinned?: boolean;
}

/** The energy rank (0 = calmest, 1 = hottest) wanted at position x (0 = first song, 1 = last). */
export function energyTarget(shape: EnergyShape, x: number): number {
  switch (shape) {
    case 'build':
      return x;
    case 'peak-time':
      return Math.pow(x, 0.6);
    case 'chill':
      return 0.35 + 0.3 * Math.sin(Math.PI * x);
    case 'party':
      // Warm up, a first peak, a breather, the biggest peak to close.
      if (x < 0.5) return 0.2 + 1.4 * x;
      if (x < 0.7) return 0.9 - 1.5 * (x - 0.5);
      return Math.min(1, 0.6 + 1.34 * (x - 0.7));
  }
}

/** Cost of playing b right after a (keys and tempo). */
export function pairCost(a: TrackAnalysis, b: TrackAnalysis): number {
  const h = HARMONIC_COST[harmonicMove(a.key, b.key)];
  const t = a.grid && b.grid ? tempoCost(tempoMatch(a.grid.bpm, b.grid.bpm)) : 4;
  return h + t;
}

const ENERGY_WEIGHT = 5;

/** Ranks 0–1 of each song's energy within the set (ties share the lower rank's order by input). */
function energyRanks(items: readonly OrderItem[]): number[] {
  const e = items.map((it) => trackEnergy(it.analysis));
  const idx = e.map((_, i) => i).sort((a, b) => e[a]! - e[b]! || a - b);
  const ranks = new Array<number>(items.length).fill(0);
  idx.forEach((i, r) => (ranks[i] = items.length > 1 ? r / (items.length - 1) : 0.5));
  return ranks;
}

/** Total cost of an order (indexes into items). */
export function orderCost(items: readonly OrderItem[], order: readonly number[], shape: EnergyShape, ranks = energyRanks(items)): number {
  const n = order.length;
  let cost = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    const x = n > 1 ? k / (n - 1) : 0;
    if (shape === 'chill' && k > 0) cost += ENERGY_WEIGHT * 0.6 * Math.abs(ranks[i]! - ranks[order[k - 1]!]!);
    cost += ENERGY_WEIGHT * Math.abs(ranks[i]! - energyTarget(shape, x));
    if (k > 0) cost += pairCost(items[order[k - 1]!]!.analysis, items[i]!.analysis);
  }
  return cost;
}

/**
 * The best order found (indexes into `items`). Pinned items stay at their own index; with no
 * unpinned items, or fewer than 2, the input order comes back.
 */
export function autoOrder(items: readonly OrderItem[], shape: EnergyShape): number[] {
  const n = items.length;
  const keep = items.map((_, i) => i);
  const free = keep.filter((i) => !items[i]!.pinned);
  if (n < 2 || free.length < 2) return keep;
  const ranks = energyRanks(items);
  const cost = (o: readonly number[]) => orderCost(items, o, shape, ranks);

  // Greedy fills, one per possible first free song.
  const greedy = (first: number): number[] => {
    const left = new Set(free);
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      if (items[k]!.pinned) {
        out.push(k);
        continue;
      }
      let pick = -1;
      let best = Infinity;
      const x = n > 1 ? k / (n - 1) : 0;
      // The first free position takes `first`; the others the best next song.
      const candidates = k === free[0] ? [first] : [...left];
      for (const c of candidates) {
        const prev = out[k - 1];
        const local =
          ENERGY_WEIGHT * Math.abs(ranks[c]! - energyTarget(shape, x)) + (prev !== undefined ? pairCost(items[prev]!.analysis, items[c]!.analysis) : 0);
        if (local < best - 1e-12) {
          best = local;
          pick = c;
        }
      }
      left.delete(pick);
      out.push(pick);
    }
    return out;
  };

  let bestOrder = keep;
  let bestCost = cost(keep);
  // Every free song as the opener for small sets; the 6 that suit the opening best for big ones.
  const x0 = n > 1 ? free[0]! / (n - 1) : 0;
  const openers =
    free.length <= 8 ? free : free.slice().sort((a, b) => Math.abs(ranks[a]! - energyTarget(shape, x0)) - Math.abs(ranks[b]! - energyTarget(shape, x0)) || a - b).slice(0, 6);
  for (const first of openers) {
    const o = improve(greedy(first), items, cost);
    const c = cost(o);
    if (c < bestCost - 1e-9) {
      bestCost = c;
      bestOrder = o;
    }
  }
  return bestOrder;
}

/** Swaps and single moves among free positions while they lower the cost (bounded passes). */
function improve(start: number[], items: readonly OrderItem[], cost: (o: readonly number[]) => number): number[] {
  let o = start.slice();
  let c = cost(o);
  const slots = o.map((_, k) => k).filter((k) => !items[o[k]!]!.pinned);
  const passes = o.length > 30 ? 3 : 20;
  for (let pass = 0; pass < passes; pass++) {
    let better = false;
    for (let a = 0; a < slots.length; a++) {
      for (let b = a + 1; b < slots.length; b++) {
        // Swap two songs.
        const s = o.slice();
        const ka = slots[a]!;
        const kb = slots[b]!;
        [s[ka], s[kb]] = [s[kb]!, s[ka]!];
        const cs = cost(s);
        if (cs < c - 1e-9) {
          o = s;
          c = cs;
          better = true;
          continue;
        }
        // Move the song at a to b (the free songs between shift by one slot).
        const m = o.slice();
        const vals = slots.map((k) => o[k]!);
        const [moved] = vals.splice(a, 1);
        vals.splice(b, 0, moved!);
        slots.forEach((k, i) => (m[k] = vals[i]!));
        const cm = cost(m);
        if (cm < c - 1e-9) {
          o = m;
          c = cm;
          better = true;
        }
      }
    }
    if (!better) break;
  }
  return o;
}
