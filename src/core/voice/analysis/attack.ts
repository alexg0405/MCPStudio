import { FULL_BAND, HIGH_BAND, LOW_BAND } from './band-energy';
import { SLOW_HALF_BLOCKS, type Envelopes } from './envelopes';
import { ampToDb, dbToAmp, median } from './math';
import type { PitchFrames } from './pitch-frames';
import { BLOCK_SEC, VOICE_THRESHOLDS } from './thresholds';
import type { Onset } from './types';

const T = VOICE_THRESHOLDS;

/** The attack is searched from this long before a flux peak to this long after it (s)… */
const SEARCH_BEFORE_SEC = 0.01;
const SEARCH_AFTER_SEC = 0.03;
/** …against the valley up to this long before it (s). */
const VALLEY_BEFORE_SEC = 0.04;
/** Stay this far clear of the previous onset (s). */
const PREVIOUS_ONSET_MARGIN_SEC = 0.01;
/** Flux frames can sit a few ms after the attack they found, so keep a margin before the next one (s). */
const NEXT_ONSET_MARGIN_SEC = 0.005;
/** How far past the recording the next-onset limit sits when there is no next onset (blocks). */
const NO_NEXT_ONSET_SLACK_BLOCKS = 5;
/** The level floor of a rise: half the noise floor, but never under 80 dB below the loudest moment. */
const RISE_FLOOR_NOISE_SHARE = 0.5;
const RISE_FLOOR_RANGE_DB = -80;
const RISE_FLOOR_MIN = 1e-9;

/** Rises of this many dB or more are clear; only rises between the threshold and this get a second look. */
const BORDERLINE_RISE_DB = 12;
/** After a note lower than this (Hz) the level ripples at the pitch rate, so it is measured over two periods. */
const LOW_NOTE_MAX_HZ = 90;

/** The block ranges one attack candidate's level rise is measured over (see `rise`). */
interface RiseWindow {
  /** First block of the valley search. */
  valleyFrom: number;
  /** The peak is searched in blocks [peakFrom, peakTo]. */
  peakFrom: number;
  peakTo: number;
  /** Level windows never reach this block (the next onset). */
  limit: number;
  /** Smallest valley level used (RMS), so a rise out of digital silence stays finite. */
  floor: number;
  /** The time before the recording counts as its typical quiet level. */
  fromStart: boolean;
}

/** A level rise in one band. */
interface Rise {
  db: number;
  peak: number;
}

/**
 * Turns a spectral-flux peak into a real attack: checks that the level actually rose (in the full
 * band, or in a sub-band that holds a real share of the sound) and finds the time it started.
 */
export class AttackFinder {
  constructor(
    private readonly envelopes: Envelopes,
    private readonly pitch: PitchFrames,
  ) {}

  /**
   * The attack behind a flux peak at `centerSec`: per band, the level peak in [center − 10 ms,
   * center + 30 ms] over the valley up to 40 ms before it (see the module comment for the second
   * looks at borderline rises). The band that rose most gives the time: on its 3 ms envelope, the
   * start of the final climb past 5 % of the way from the valley to the peak. Null when nothing
   * rose at all.
   */
  find(centerSec: number, prevTime: number, nextTime: number, flux: number, minRiseDb: number): Onset | null {
    const env = this.envelopes;
    const valleyFrom = env.blockAt(Math.max(centerSec - VALLEY_BEFORE_SEC, prevTime + PREVIOUS_ONSET_MARGIN_SEC));
    const peakFrom = env.blockAt(Math.max(centerSec - SEARCH_BEFORE_SEC, prevTime + PREVIOUS_ONSET_MARGIN_SEC));
    const peakTo = env.blockAt(Math.min(centerSec + SEARCH_AFTER_SEC, nextTime - NEXT_ONSET_MARGIN_SEC));
    if (peakTo < peakFrom) return null;
    const limit = Number.isFinite(nextTime)
      ? env.blockAt(nextTime - NEXT_ONSET_MARGIN_SEC)
      : env.blocks + NO_NEXT_ONSET_SLACK_BLOCKS;
    const floor = Math.max(
      env.noise * RISE_FLOOR_NOISE_SHARE,
      env.peakLevel * dbToAmp(RISE_FLOOR_RANGE_DB),
      RISE_FLOOR_MIN,
    );
    // A sound at the very start has no "before" in the recording: compare with its quiet level.
    const fromStart = prevTime === -Infinity && centerSec - VALLEY_BEFORE_SEC < 0;
    const window: RiseWindow = { valleyFrom, peakFrom, peakTo, limit, floor, fromStart };

    const rises = this.risesWithSecondLook(window, centerSec, minRiseDb);
    const { band, riseDb, fullRiseDb } = this.strongestBand(rises);
    const time = this.attackTime(band, window);
    if (time === null) return null;
    return { time, flux, riseDb, fullRiseDb };
  }

  /**
   * The rise in each band. Only a borderline rise is worth a second look (clear ones stand, small
   * ones fail anyway): after a low note the level is measured over two pitch periods, after noise
   * the valley is the median rather than the minimum.
   */
  private risesWithSecondLook(window: RiseWindow, centerSec: number, minRiseDb: number): Rise[] {
    const rises = [FULL_BAND, LOW_BAND, HIGH_BAND].map((band) => this.rise(window, band, SLOW_HALF_BLOCKS));
    const best = Math.max(...rises.map((r) => r.db));
    if (!(best >= minRiseDb && best < BORDERLINE_RISE_DB)) return rises;
    const before = this.pitch.soundBefore(centerSec);
    if (before.f0 > 0 && before.f0 < LOW_NOTE_MAX_HZ) {
      const halfBlocks = Math.max(SLOW_HALF_BLOCKS, Math.round(1 / before.f0 / BLOCK_SEC));
      rises[FULL_BAND] = this.rise(window, FULL_BAND, halfBlocks);
      rises[LOW_BAND] = this.rise(window, LOW_BAND, halfBlocks);
    } else if (before.periodicity < T.swellPeriodicity) {
      // In noise the minimum of a few RMS readings is biased low (a breath "rises" by chance):
      // compare with the median level before the candidate instead.
      for (let band = 0; band < rises.length; band++) {
        rises[band] = this.rise(window, band, SLOW_HALF_BLOCKS, window.peakFrom);
      }
    }
    return rises;
  }

  /** The band whose rise counts most, and its rise (dB), with the full-band rise for reference. */
  private strongestBand(rises: Rise[]): { band: number; riseDb: number; fullRiseDb: number } {
    const full = rises[FULL_BAND] as Rise;
    let band = FULL_BAND;
    let riseDb = full.db;
    rises.forEach((r, b) => {
      // A sub-band counts when it carries a real part of the sound (≥ −10 dB of the full band), and
      // must rise more than the full band would have to: narrow bands of noise wobble more.
      if (b === FULL_BAND || r.peak < dbToAmp(T.subBandShareDb) * full.peak) return;
      const penaltyDb = b === LOW_BAND ? T.lowBandPenaltyDb : T.highBandPenaltyDb;
      const db = Math.max(full.db, r.db - penaltyDb);
      if (db > riseDb) {
        riseDb = db;
        band = b;
      }
    });
    return { band, riseDb, fullRiseDb: full.db };
  }

  /** The onset time on the 3 ms envelope of `band`; null when that envelope is silent over the search window. */
  private attackTime(band: number, window: RiseWindow): number | null {
    const env = this.envelopes;
    const fast = env.fast[band] as Float32Array;
    const peak = env.maxIn(fast, window.peakFrom, window.peakTo);
    if (!(peak.value > 0)) return null;
    const valley = env.minIn(fast, Math.min(window.valleyFrom, peak.at), peak.at);
    // Relative to the 11 ms peak: the 3 ms one rides the ripple crests of low notes.
    const slowPeak = env.maxIn(env.slow[band] as Float32Array, window.peakFrom, window.peakTo).value;
    const reference = Math.max(valley.value, slowPeak);
    const level = valley.value + T.onsetFraction * (reference - valley.value);
    // Walk back from the peak to the first block under the level (not across troughs: the rippling
    // tail of a previous kick can sit above it).
    let at = peak.at;
    while (at > valley.at && (fast[at - 1] as number) >= level) at--;
    // The 3 ms window reaches one block ahead, so a sharp attack shows a block early.
    return env.blockStart(at + 1);
  }

  /**
   * Level rise of `band` (RMS over 2h + 1 blocks): the peak in the peak range over the valley in
   * [valleyFrom, peak]. With `medianUntil` the valley is the median level over [valleyFrom,
   * medianUntil] instead of the minimum.
   */
  private rise(window: RiseWindow, band: number, halfBlocks: number, medianUntil = -1): Rise {
    const env = this.envelopes;
    const slow = halfBlocks === SLOW_HALF_BLOCKS ? (env.slow[band] as Float32Array) : null;
    const level = (j: number) => (slow ? (slow[j] as number) : env.levelAt(band, j, halfBlocks));
    let peak = 0;
    let peakAt = window.peakFrom;
    for (let j = window.peakFrom; j <= Math.min(window.peakTo, window.limit - halfBlocks - 1); j++) {
      const v = level(j);
      if (v > peak) {
        peak = v;
        peakAt = j;
      }
    }
    const valleyFrom = Math.min(window.valleyFrom, peakAt);
    let valley = window.fromStart ? env.quiet : Infinity;
    if (medianUntil >= 0) {
      const before: number[] = [];
      for (let j = valleyFrom; j <= Math.min(medianUntil, peakAt); j++) before.push(level(j));
      if (before.length > 0) valley = Math.min(valley, median(before));
    } else {
      for (let j = valleyFrom; j <= peakAt; j++) valley = Math.min(valley, level(j));
    }
    return { db: ampToDb(peak) - ampToDb(Math.max(valley, window.floor)), peak };
  }
}
