import type { Onset } from './onsets';

/** A stretch of the input kept at its own speed around an attack. */
export interface Zone {
  /** Input frame of the attack; the zone keeps [c − pre, c + post] of the input at its own speed. */
  c: number;
  /** Output frame the attack lands on (c × scale). */
  oc: number;
}

/** A gap between two zones may be stretched at most this much more or less than the overall scale. */
const MAX_LOCAL_SCALE_RATIO = 2;

/**
 * Chooses the attacks to keep whole: strongest first, as long as the stretch can still be made up
 * between neighbours (each gap stays at least a hop long and stretched by at most 2× more, or 2×
 * less, than the overall scale). Zones come back sorted by position.
 */
export function placeZones(
  onsets: readonly Onset[],
  scale: number,
  pre: number,
  post: number,
  hop: number,
  inLen: number,
  outLen: number,
): Zone[] {
  const accepted: Zone[] = [];
  const gapOk = (aIn: number, aOut: number, bIn: number, bOut: number) => {
    const gapIn = bIn - aIn;
    const gapOut = bOut - aOut;
    if (gapIn < hop || gapOut < hop) return false;
    const local = gapOut / gapIn;
    return local <= scale * MAX_LOCAL_SCALE_RATIO && local >= scale / MAX_LOCAL_SCALE_RATIO;
  };
  const strongestFirst = [...onsets].sort((a, b) => b.strength - a.strength);
  for (const onset of strongestFirst) {
    const zone: Zone = { c: onset.at, oc: Math.round(onset.at * scale) };
    // Neighbours among the accepted ones (kept sorted by position).
    let i = 0;
    while (i < accepted.length && (accepted[i] as Zone).c < zone.c) i++;
    const prev = accepted[i - 1];
    const next = accepted[i];
    const fitsBefore = prev
      ? gapOk(prev.c + post, prev.oc + post, zone.c - pre, zone.oc - pre)
      : gapOk(0, 0, zone.c - pre, zone.oc - pre);
    const fitsAfter = next
      ? gapOk(zone.c + post, zone.oc + post, next.c - pre, next.oc - pre)
      : gapOk(zone.c + post, zone.oc + post, inLen, outLen);
    if (fitsBefore && fitsAfter) accepted.splice(i, 0, zone);
  }
  return accepted;
}
