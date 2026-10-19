import { AttackFinder } from './attack';
import type { Envelopes } from './envelopes';
import { onsetFlux } from './flux';
import { dbToAmp } from './math';
import type { PitchFrames } from './pitch-frames';
import { VOICE_THRESHOLDS, bySensitivity } from './thresholds';
import type { Onset } from './types';

const T = VOICE_THRESHOLDS;

/** A flux peak is the largest value within this many frames on both sides. */
const PEAK_NEIGHBOURHOOD_FRAMES = 2;
/** The adaptive threshold's median is taken over frames [i − 6, i + 3] (~95 ms at 100 frames/s). */
const MEDIAN_FRAMES_BEFORE = 6;
const MEDIAN_FRAMES_AFTER = 3;

/** Stay clear of the next candidate: its flux frame can trail a soft attack by this much (s). */
const NEXT_CANDIDATE_GUARD_SEC = 0.03;
/** Even when the next candidate is very close, the loudness search covers at least this much (s). */
const MIN_LEVEL_SEARCH_SEC = 0.005;
/** How far after the onset a swell's half-level point is looked for (s). */
const SWELL_SEARCH_SEC = 0.4;
/** A swell reaches half its peak level slower than `swellAttackSec`. */
const SWELL_HALF_LEVEL = 0.5;
/** A later flux peak replaces an earlier one inside the minimum gap when it is this many times stronger. */
const STRONGER_ONSET_FLUX_RATIO = 2;

/** A flux peak that might be an onset. */
interface Candidate {
  frame: number;
  flux: number;
}

/** Finds the moments a new sound starts: flux peaks, checked on the level envelopes and gated. */
export class OnsetDetector {
  private readonly attacks: AttackFinder;
  /** Samples between onset-detection frames: twice the pitch hop (~10 ms, 100 frames/s). */
  private readonly fluxHop: number;

  constructor(
    private readonly samples: Float32Array,
    private readonly sampleRate: number,
    private readonly envelopes: Envelopes,
    private readonly pitch: PitchFrames,
    private readonly settings: { sensitivity: number; minGapSec: number },
  ) {
    this.attacks = new AttackFinder(envelopes, pitch);
    this.fluxHop = 2 * pitch.hop;
  }

  /** Onsets in time order, none closer than the minimum gap. */
  detect(): Onset[] {
    const env = this.envelopes;
    const flux = onsetFlux(this.samples, this.sampleRate, this.fluxHop, env.noise, env.peakLevel);
    const candidates = pickFluxPeaks(flux, this.atSensitivity(T.fluxOffset));
    const accepted = this.acceptCandidates(candidates);
    accepted.sort((a, b) => a.time - b.time);
    return collapseCloseOnsets(accepted, this.settings.minGapSec);
  }

  private atSensitivity(pair: readonly [number, number]): number {
    return bySensitivity(pair, this.settings.sensitivity);
  }

  /** The candidates that rise enough, are loud enough and are not swells, as onsets. */
  private acceptCandidates(candidates: Candidate[]): Onset[] {
    const env = this.envelopes;
    const gate = Math.max(
      env.noise * dbToAmp(this.atSensitivity(T.gateAboveNoiseDb)),
      env.peakLevel * dbToAmp(-this.atSensitivity(T.gateRangeDb)),
    );
    const minRiseDb = this.atSensitivity(T.onsetRiseDb);
    const accepted: Onset[] = [];
    let prevTime = -Infinity;
    for (let c = 0; c < candidates.length; c++) {
      const candidate = candidates[c] as Candidate;
      const next = candidates[c + 1];
      const centerSec = this.frameTime(candidate.frame);
      const nextTime = next ? this.frameTime(next.frame) : Infinity;
      const onset = this.attacks.find(centerSec, prevTime, nextTime, candidate.flux, minRiseDb);
      if (!onset || onset.riseDb < minRiseDb) continue;
      if (!this.isLoudEnough(onset.time, nextTime, gate)) continue;
      if (this.isSwell(onset.time, nextTime)) continue;
      accepted.push(onset);
      prevTime = onset.time;
    }
    return accepted;
  }

  /** The time a flux frame is centered at (s). */
  private frameTime(frame: number): number {
    return (frame * this.fluxHop) / this.sampleRate;
  }

  /** The end of the span an onset is judged over: it stops clear of the next candidate. */
  private searchEnd(onsetSec: number, nextTime: number): number {
    return Math.max(onsetSec + MIN_LEVEL_SEARCH_SEC, nextTime - NEXT_CANDIDATE_GUARD_SEC);
  }

  /** Whether the sound's level in its first 60 ms clears the gate. */
  private isLoudEnough(onsetSec: number, nextTime: number, gate: number): boolean {
    const env = this.envelopes;
    const stop = this.searchEnd(onsetSec, nextTime);
    const to = env.blockAt(Math.min(onsetSec + T.featureSec, stop));
    return env.maxIn(env.level, env.blockAt(onsetSec), to).value >= gate;
  }

  /** A noisy sound that takes long to reach half its peak is a swell (a breath), not an attack. */
  private isSwell(onsetSec: number, nextTime: number): boolean {
    const env = this.envelopes;
    const stop = this.searchEnd(onsetSec, nextTime);
    const startBlock = env.blockAt(onsetSec);
    const later = env.maxIn(env.level, startBlock, env.blockAt(Math.min(onsetSec + SWELL_SEARCH_SEC, stop))).value;
    let reach = startBlock;
    while (reach < env.blocks - 1 && (env.level[reach] as number) < SWELL_HALF_LEVEL * later) reach++;
    const attackSec = env.blockStart(reach) - onsetSec;
    return attackSec > T.swellAttackSec && this.pitch.periodicity(onsetSec, nextTime) < T.swellPeriodicity;
  }
}

/**
 * Local maxima of the flux that stand out of their surroundings: above `offset` and at least
 * `fluxMedianFactor` × the moving median + `offset` (an adaptive threshold that rides on busy music).
 */
function pickFluxPeaks(flux: Float32Array, offset: number): Candidate[] {
  const scratch = new Float64Array(MEDIAN_FRAMES_BEFORE + MEDIAN_FRAMES_AFTER + 1);
  const candidates: Candidate[] = [];
  for (let i = 0; i < flux.length; i++) {
    const value = flux[i] as number;
    if (value <= offset) continue;
    if (!isLocalMaximum(flux, i)) continue;
    const median = movingMedian(flux, i, scratch);
    if (value >= T.fluxMedianFactor * median + offset) candidates.push({ frame: i, flux: value });
  }
  return candidates;
}

/** Whether flux[i] beats its neighbours: earlier ones must be strictly lower, later ones may tie. */
function isLocalMaximum(flux: Float32Array, i: number): boolean {
  const value = flux[i] as number;
  for (let d = -PEAK_NEIGHBOURHOOD_FRAMES; d <= PEAK_NEIGHBOURHOOD_FRAMES; d++) {
    if (d === 0 || i + d < 0 || i + d >= flux.length) continue;
    const other = flux[i + d] as number;
    if (d < 0 ? other >= value : other > value) return false;
  }
  return true;
}

/** Median of flux over [i − 6, i + 3] (insertion sort into the scratch buffer, so nothing is allocated). */
function movingMedian(flux: Float32Array, i: number, scratch: Float64Array): number {
  let count = 0;
  for (let j = Math.max(0, i - MEDIAN_FRAMES_BEFORE); j <= Math.min(flux.length - 1, i + MEDIAN_FRAMES_AFTER); j++) {
    const value = flux[j] as number;
    let slot = count++;
    while (slot > 0 && (scratch[slot - 1] as number) > value) {
      scratch[slot] = scratch[slot - 1] as number;
      slot--;
    }
    scratch[slot] = value;
  }
  const middle = count >> 1;
  if (count & 1) return scratch[middle] as number;
  return ((scratch[middle - 1] as number) + (scratch[middle] as number)) / 2;
}

/** Collapses onsets closer than `minGapSec`: keeps the earlier one unless the later is much stronger. */
function collapseCloseOnsets(onsets: Onset[], minGapSec: number): Onset[] {
  const kept: Onset[] = [];
  for (const onset of onsets) {
    const last = kept[kept.length - 1];
    if (!last || onset.time - last.time >= minGapSec) {
      kept.push(onset);
      continue;
    }
    if (onset.flux > STRONGER_ONSET_FLUX_RATIO * last.flux) {
      kept[kept.length - 1] = onset;
      continue;
    }
    last.riseDb = Math.max(last.riseDb, onset.riseDb);
    last.fullRiseDb = Math.max(last.fullRiseDb, onset.fullRiseDb);
  }
  return kept;
}
