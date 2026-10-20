/**
 * Picking a clean example of each kind of drum hit from a recording, to cut into a Drum Pads pad: the hit with the most
 * room around it (no other hit starting right with it or soon after) and a good level, cut from just before its start to
 * where the next hit begins (or to the most a hit of its kind rings). Pure.
 */
import type { DrumKind, HeardHit, KitCut } from './types';

/** How long each kind may ring in the cut at most (s). */
const RING_SEC: Readonly<Record<DrumKind, number>> = { kick: 0.6, snare: 0.4, clap: 0.35, hat: 0.12, 'open-hat': 0.6, tom: 0.5, cymbal: 1.5, perc: 0.25 };
/** A cut starts this long before the hit (s), so the attack is whole. */
const LEAD_SEC = 0.004;
/** A cut ends this long before the next hit (s). */
const TAIL_GAP_SEC = 0.006;
/** Another hit this close to the start (s) is sounding with it, and spoils the example. */
const TOGETHER_SEC = 0.02;
/** The room after a hit that counts for choosing (s): more is no better. */
const ROOM_CAP_SEC = 0.5;

/** The time of the next hit after `hit` that is not sounding with it (Infinity for none). */
function nextHitAfter(hits: readonly HeardHit[], hit: HeardHit): number {
  let next = Infinity;
  for (const other of hits) if (other.timeSec > hit.timeSec + TOGETHER_SEC && other.timeSec < next) next = other.timeSec;
  return next;
}

/** How good an example a hit is: nothing sounding with it first, then room after it, then its level. */
function exampleScore(hits: readonly HeardHit[], hit: HeardHit): number {
  const together = hits.filter((other) => other !== hit && Math.abs(other.timeSec - hit.timeSec) <= TOGETHER_SEC).length;
  const room = Math.min(ROOM_CAP_SEC, nextHitAfter(hits, hit) - hit.timeSec);
  return -together * 10 + room + 0.2 * hit.strength;
}

/** The cut for one hit. */
function cutOf(hits: readonly HeardHit[], hit: HeardHit, durationSec: number): KitCut {
  const next = nextHitAfter(hits, hit);
  const to = Math.min(durationSec, hit.timeSec + RING_SEC[hit.kind], next - TAIL_GAP_SEC);
  const from = Math.max(0, hit.timeSec - LEAD_SEC);
  return { kind: hit.kind, fromSec: from, toSec: Math.max(from + 0.02, to), ...(hit.bodyHz !== undefined ? { bodyHz: hit.bodyHz } : {}) };
}

/** The clean example of each kind of hit in `hits` (one per kind; toms: one per distinct pitch group is left to the planner). */
export function cutsFor(hits: readonly HeardHit[], durationSec: number): KitCut[] {
  const cuts: KitCut[] = [];
  const kinds = new Set(hits.map((h) => h.kind));
  for (const kind of kinds) {
    const ofKind = hits.filter((h) => h.kind === kind);
    for (const group of kind === 'tom' ? tomGroups(ofKind) : [ofKind]) {
      let best = group[0] as HeardHit;
      for (const h of group) if (exampleScore(hits, h) > exampleScore(hits, best)) best = h;
      cuts.push(cutOf(hits, best, durationSec));
    }
  }
  return cuts;
}

/** Toms of about the same pitch (within a major third) are one drum: a group per drum, lowest first. */
export function tomGroups(toms: readonly HeardHit[]): HeardHit[][] {
  const sorted = [...toms].sort((a, b) => (a.bodyHz ?? 0) - (b.bodyHz ?? 0));
  const groups: HeardHit[][] = [];
  for (const tom of sorted) {
    const last = groups[groups.length - 1];
    const reference = last?.[0]?.bodyHz ?? 0;
    if (last && (tom.bodyHz ?? 0) <= reference * 1.26) last.push(tom);
    else groups.push([tom]);
  }
  return groups;
}
