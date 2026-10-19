import type { MonoReader } from './onsets';

/** Energies never drop below this, so a silent window cannot divide by zero. */
const ENERGY_FLOOR = 1e-12;
/** The coarse pass works on a mix decimated to about this rate (Hz). */
export const COARSE_RATE_HZ = 6000;

/** Everything the search needs to know about the stretch's frame sizes. */
export interface SimilarityGeometry {
  /** Half a frame (the overlap that has to match), in frames at the full rate. */
  halfFrame: number;
  /** The decimation factor of the coarse mix. */
  decimation: number;
  /** The padding the decimated mix has before the signal, in decimated frames. */
  decimatedPad: number;
}

/** `search(target, nominal, lo, hi)`: see `createSimilaritySearch`. */
export type SimilaritySearch = (target: number, nominal: number, lo: number, hi: number) => number;

/**
 * Finds where to cut the next frame so it continues the previous one: the start in
 * [nominal + lo, nominal + hi] whose first half frame best matches (normalized correlation) the
 * input at `target`. A coarse pass on the decimated mix (`decimated`) finds the neighbourhood and a
 * fine pass at the full rate (read through `readMono`) picks the exact frame. Ties (silence) go to the
 * candidate nearest the nominal position, so silence doesn't drift. Both passes slide the candidate's
 * energy window by one instead of summing it again, and nothing is allocated per call.
 */
export function createSimilaritySearch(
  decimated: Float32Array,
  readMono: MonoReader,
  geometry: SimilarityGeometry,
  toleranceFrames: number,
): SimilaritySearch {
  const { halfFrame, decimation, decimatedPad } = geometry;
  // Windows of the mix for the fine search: the target half frame, and the candidates' span.
  const targetWindow = new Float32Array(halfFrame);
  const candidateWindow = new Float32Array(halfFrame + 2 * toleranceFrames + 4);

  /** The best offset from `nominal` on the decimated mix, in full-rate frames. */
  const coarseOffset = (target: number, nominal: number, lo: number, hi: number): number => {
    const length = Math.max(1, Math.floor(halfFrame / decimation));
    const targetStart = Math.floor(target / decimation) + decimatedPad;
    const firstCandidate = Math.floor((nominal + lo) / decimation) + decimatedPad;
    const lastCandidate = Math.ceil((nominal + hi) / decimation) + decimatedPad;
    let candidateEnergy = ENERGY_FLOOR;
    for (let i = 0; i < length; i++) candidateEnergy += (decimated[firstCandidate + i] as number) ** 2;
    const nominalCandidate = Math.round(nominal / decimation) + decimatedPad;
    let best = firstCandidate;
    let bestScore = -Infinity;
    for (let candidate = firstCandidate; candidate <= lastCandidate; candidate++) {
      let correlation = 0;
      for (let i = 0; i < length; i++) {
        correlation += (decimated[targetStart + i] as number) * (decimated[candidate + i] as number);
      }
      const score = correlation / Math.sqrt(candidateEnergy);
      const isNearerTie =
        score === bestScore && Math.abs(candidate - nominalCandidate) < Math.abs(best - nominalCandidate);
      if (score > bestScore || isNearerTie) {
        bestScore = score;
        best = candidate;
      }
      // Slide the candidate's energy window by one.
      candidateEnergy += (decimated[candidate + length] as number) ** 2 - (decimated[candidate] as number) ** 2;
      if (candidateEnergy < ENERGY_FLOOR) candidateEnergy = ENERGY_FLOOR;
    }
    return (best - decimatedPad) * decimation - nominal;
  };

  /** The best offset from `nominal` at the full rate, searching [fineFrom, fineTo]. */
  const fineOffset = (target: number, nominal: number, fineFrom: number, fineTo: number): number => {
    readMono(targetWindow, target, halfFrame);
    readMono(candidateWindow, nominal + fineFrom, fineTo - fineFrom + halfFrame + 1);
    let candidateEnergy = ENERGY_FLOOR;
    for (let i = 0; i < halfFrame; i++) candidateEnergy += (candidateWindow[i] as number) ** 2;
    let best = fineFrom;
    let bestScore = -Infinity;
    for (let offset = fineFrom; offset <= fineTo; offset++) {
      const at = offset - fineFrom;
      let correlation = 0;
      for (let i = 0; i < halfFrame; i++) {
        correlation += (targetWindow[i] as number) * (candidateWindow[at + i] as number);
      }
      const score = correlation / Math.sqrt(candidateEnergy);
      if (score > bestScore || (score === bestScore && Math.abs(offset) < Math.abs(best))) {
        bestScore = score;
        best = offset;
      }
      candidateEnergy += (candidateWindow[at + halfFrame] as number) ** 2 - (candidateWindow[at] as number) ** 2;
      if (candidateEnergy < ENERGY_FLOOR) candidateEnergy = ENERGY_FLOOR;
    }
    return best;
  };

  return (target, nominal, lo, hi) => {
    const coarse = coarseOffset(target, nominal, lo, hi);
    // Fine: full rate around the coarse pick.
    const fineFrom = Math.max(lo, coarse - decimation);
    const fineTo = Math.min(hi, coarse + decimation);
    return nominal + fineOffset(target, nominal, fineFrom, fineTo);
  };
}

/**
 * The mix decimated to about 6 kHz (a plain average of `decimation` frames) over the signal padded on
 * both sides as the fine search sees it: `decimated[j]` covers input frames [j × D − pad, (j + 1) × D − pad).
 */
export function decimateMix(readMono: MonoReader, inLen: number, padFrames: number, decimation: number): Float32Array {
  const length = Math.floor((inLen + 2 * padFrames) / decimation);
  const decimated = new Float32Array(length);
  const blockOutputs = 2048;
  const block = new Float32Array(blockOutputs * decimation);
  for (let first = 0; first < length; first += blockOutputs) {
    const count = Math.min(blockOutputs, length - first);
    readMono(block, first * decimation - padFrames, count * decimation);
    for (let j = 0; j < count; j++) {
      let sum = 0;
      for (let k = 0; k < decimation; k++) sum += block[j * decimation + k] as number;
      decimated[first + j] = sum / decimation;
    }
  }
  return decimated;
}
