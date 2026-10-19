import { bandEnergyPrefixSums } from './band-energy';
import { ampToDb, dbToAmp } from './math';
import { BLOCK_SEC, VOICE_THRESHOLDS } from './thresholds';

/** Half-width (in blocks) of the level window: 2 × 5 + 1 blocks = 11 ms. Used for levels, rises and decay. */
export const SLOW_HALF_BLOCKS = 5;
/** Half-width (in blocks) of the onset-time window: 2 × 1 + 1 blocks = 3 ms. */
const FAST_HALF_BLOCKS = 1;

/** The level histogram that finds the quiet level: 0.5 dB bins from −160 dB. */
const HISTOGRAM_FLOOR_DB = -160;
const HISTOGRAM_BINS_PER_DB = 2;
const HISTOGRAM_BINS = 400;
/** Which share of the blocks counts as "quiet": the recording's typical background level. */
const QUIET_PERCENTILE = 0.1;

/** How long the level must stay under a threshold before a sound counts as ended (blocks, 1 ms each). */
const BELOW_HOLD_BLOCKS = 10;

/** A position in an envelope and the value found there. */
export interface Peak {
  at: number;
  value: number;
}

/**
 * The level of a recording on 1 ms blocks in three bands (full, < 300 Hz, > 3 kHz): 11 ms RMS for
 * levels, rises and decay, 3 ms RMS for onset times, plus the loudest moment and the noise floor.
 * Indices into the envelopes are block numbers.
 */
export class Envelopes {
  /** Samples per block. */
  readonly block: number;
  readonly blocks: number;
  /** 11 ms RMS per band. `slow[0]` (the full band) is the level used everywhere. */
  readonly slow: Float32Array[];
  /** 3 ms RMS per band (onset times). */
  readonly fast: Float32Array[];
  /** The full-band 11 ms level. */
  readonly level: Float32Array;
  /** The level of the loudest moment. */
  readonly peakLevel: number;
  /** The recording's typical quiet level (the 10th percentile), uncapped. */
  readonly quiet: number;
  /** The noise floor: the quiet level, capped under the loudest moment so continuous humming still has one. */
  readonly noise: number;
  /** Prefix sums of the block energies per band (any RMS window from them). */
  private readonly prefix: Float64Array[];

  constructor(
    samples: Float32Array,
    private readonly sampleRate: number,
  ) {
    this.block = Math.max(1, Math.round(sampleRate * BLOCK_SEC));
    this.blocks = Math.ceil(samples.length / this.block);
    this.prefix = bandEnergyPrefixSums(samples, this.block, this.blocks, sampleRate);
    this.slow = this.prefix.map((sums) => this.rms(sums, SLOW_HALF_BLOCKS));
    this.fast = this.prefix.map((sums) => this.rms(sums, FAST_HALF_BLOCKS));
    this.level = this.slow[0] as Float32Array;
    let peak = 0;
    for (let j = 0; j < this.blocks; j++) peak = Math.max(peak, this.level[j] as number);
    this.peakLevel = peak;
    this.quiet = this.percentile(this.level, QUIET_PERCENTILE);
    this.noise = Math.min(this.quiet, peak * dbToAmp(-VOICE_THRESHOLDS.noiseCapDb));
  }

  /** RMS of `band` over 2h + 1 blocks centered on block j (zeros beyond the ends). */
  levelAt(band: number, j: number, halfBlocks: number): number {
    const sums = this.prefix[band] as Float64Array;
    const lo = Math.min(this.blocks, Math.max(0, j - halfBlocks));
    const hi = Math.min(this.blocks, Math.max(0, j + halfBlocks + 1));
    const window = (2 * halfBlocks + 1) * this.block;
    return Math.sqrt(Math.max(0, (sums[hi] as number) - (sums[lo] as number)) / window);
  }

  /** The block that holds a time (clamped to the recording). */
  blockAt(sec: number): number {
    return Math.min(this.blocks - 1, Math.max(0, Math.floor((sec * this.sampleRate) / this.block)));
  }

  /** Start time of block j (s). */
  blockStart(j: number): number {
    return (j * this.block) / this.sampleRate;
  }

  /** The loudest value of `envelope` over blocks [from, to] (the first one wins a tie; 0 when all are 0). */
  maxIn(envelope: Float32Array, from: number, to: number): Peak {
    const lo = Math.max(0, from);
    let at = lo;
    let value = 0;
    for (let j = lo; j <= Math.min(this.blocks - 1, to); j++) {
      if ((envelope[j] as number) > value) {
        value = envelope[j] as number;
        at = j;
      }
    }
    return { at, value };
  }

  /** The quietest value of `envelope` over blocks [from, to] (0 for an empty range). */
  minIn(envelope: Float32Array, from: number, to: number): Peak {
    const lo = Math.max(0, from);
    let at = lo;
    let value = Infinity;
    for (let j = lo; j <= Math.min(this.blocks - 1, to); j++) {
      if ((envelope[j] as number) < value) {
        value = envelope[j] as number;
        at = j;
      }
    }
    return { at, value: Number.isFinite(value) ? value : 0 };
  }

  /**
   * First block in [from, to] where the level stays below `level` for 10 ms (or from where it is
   * below up to `to`); −1 if it never goes below.
   */
  firstBelow(from: number, to: number, level: number): number {
    let run = 0;
    for (let j = from; j <= to; j++) {
      if ((this.level[j] as number) < level) {
        if (++run >= BELOW_HOLD_BLOCKS) return j - (BELOW_HOLD_BLOCKS - 1);
      } else run = 0;
    }
    return run > 0 ? to - run + 1 : -1;
  }

  /** Centered RMS over 2h + 1 blocks for every block. */
  private rms(prefix: Float64Array, halfBlocks: number): Float32Array {
    const out = new Float32Array(this.blocks);
    const norm = 1 / ((2 * halfBlocks + 1) * this.block);
    for (let j = 0; j < this.blocks; j++) {
      const lo = Math.max(0, j - halfBlocks);
      const hi = Math.min(this.blocks, j + halfBlocks + 1);
      out[j] = Math.sqrt(Math.max(0, (prefix[hi] as number) - (prefix[lo] as number)) * norm);
    }
    return out;
  }

  /** Level percentile, from a 0.5 dB histogram. */
  private percentile(levels: Float32Array, share: number): number {
    const bins = new Uint32Array(HISTOGRAM_BINS);
    for (let j = 0; j < levels.length; j++) {
      const dbAboveFloor = ampToDb(levels[j] as number) - HISTOGRAM_FLOOR_DB;
      const bin = Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.floor(dbAboveFloor * HISTOGRAM_BINS_PER_DB)));
      bins[bin] = (bins[bin] as number) + 1;
    }
    const target = share * levels.length;
    let counted = 0;
    for (let bin = 0; bin < bins.length; bin++) {
      counted += bins[bin] as number;
      if (counted >= target) return dbToAmp(HISTOGRAM_FLOOR_DB + (bin + 0.5) / HISTOGRAM_BINS_PER_DB);
    }
    return dbToAmp(HISTOGRAM_FLOOR_DB);
  }
}
