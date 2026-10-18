/**
 * Finds attacks (drum hits, plucks) in a song lazily, around the place a deck is about to read: the key-lock stretch
 * (`deck.kernel.ts`) asks for the attacks between two song positions and keeps each one whole instead of smearing it.
 *
 * Audio-thread code: no allocation after construction (all arrays are made once, results go into fixed arrays).
 */

/** Hops of mean-square energy kept in the cache (a power of two: the slot is the hop index masked). */
const ENERGY_CACHE_HOPS = 1024;
const ENERGY_CACHE_MASK = ENERGY_CACHE_HOPS - 1;
/** Hops compared before an attack (the quiet it rises from) and from it on (the loud it rises to). */
const PRE_HOPS = 8;
const POST_HOPS = 4;
/** Mean square under which nothing counts as an attack (−60 dBFS). */
const GATE_MEAN_SQUARE = 1e-6;
/** An attack is a rise of the next ~10 ms of energy to this many times the ~20 ms before. */
const RISE_RATIO = 8;
/** A tiny floor so a silent lead-in doesn't make every sound an attack by dividing by nothing. */
const RISE_FLOOR = 1e-12;
/** How many hops before the asked range a search starts, so an attack that began just before it is still found. */
const LOOKBACK_HOPS = 12;
/** Most attacks reported per scan. */
export const MAX_ONSETS = 24;
/** The refined start of an attack is cached per hop in this many slots (a power of two minus one is the mask). */
const REFINE_CACHE_SLOTS = 64;
const REFINE_CACHE_MASK = REFINE_CACHE_SLOTS - 1;
/** An attack starts at the first sample that reaches this fraction of the peak around it. */
const ATTACK_START_FRACTION = 0.3;
/** Hops per second the detector looks at (a hop is ~2.7 ms). */
const HOPS_PER_SEC = 375;
const MIN_HOP_FRAMES = 32;

/** Copies `len` frames of the song from `start` into the two arrays (zeros where there is no audio). */
export type ReadRange = (left: Float32Array, right: Float32Array, start: number, len: number) => void;

/** An attack detector that reads the song through `readRange` and remembers what it has already measured. */
export class OnsetScanner {
  /** Frames of song per detection hop. */
  readonly hop: number;
  /** After `scan`: how many attacks were found, the frame of each (ascending) and how strong each is. */
  count = 0;
  readonly frames = new Float64Array(MAX_ONSETS);
  readonly strengths = new Float64Array(MAX_ONSETS);

  private readonly energy = new Float64Array(ENERGY_CACHE_HOPS);
  private readonly energyHop = new Int32Array(ENERGY_CACHE_HOPS).fill(-1);
  private readonly hopLeft: Float32Array;
  private readonly hopRight: Float32Array;
  private readonly refineLeft: Float32Array;
  private readonly refineRight: Float32Array;
  private readonly refinedHop = new Int32Array(REFINE_CACHE_SLOTS).fill(-1);
  private readonly refinedFrame = new Float64Array(REFINE_CACHE_SLOTS);

  constructor(
    sampleRate: number,
    private readonly readRange: ReadRange,
  ) {
    this.hop = Math.max(MIN_HOP_FRAMES, Math.round(sampleRate / HOPS_PER_SEC));
    this.hopLeft = new Float32Array(this.hop);
    this.hopRight = new Float32Array(this.hop);
    this.refineLeft = new Float32Array((POST_HOPS + 2) * this.hop);
    this.refineRight = new Float32Array((POST_HOPS + 2) * this.hop);
  }

  /** Forgets everything measured (the song, or the loop that changes what is read past its end, changed). */
  clearCache(): void {
    this.energyHop.fill(-1);
    this.refinedHop.fill(-1);
  }

  /** Mean square of the mono mix over hop `h` (frames h·hop…), cached by hop index; zero before the song. */
  private energyOf(h: number): number {
    if (h < 0) return 0;
    const slot = h & ENERGY_CACHE_MASK;
    if (this.energyHop[slot] === h) return this.energy[slot] as number;
    const hop = this.hop;
    this.readRange(this.hopLeft, this.hopRight, h * hop, hop);
    let sum = 0;
    for (let j = 0; j < hop; j++) {
      const mono = 0.5 * ((this.hopLeft[j] as number) + (this.hopRight[j] as number));
      sum += mono * mono;
    }
    const meanSquare = sum / hop;
    this.energyHop[slot] = h;
    this.energy[slot] = meanSquare;
    return meanSquare;
  }

  /** The first frame of an attack that hop `h` is the strongest rise of: the first sample that reaches 30 % of its peak. */
  private refine(h: number): number {
    const hop = this.hop;
    const startFrame = (h - 1) * hop;
    const len = (POST_HOPS + 2) * hop;
    this.readRange(this.refineLeft, this.refineRight, startFrame, len);
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const mono = Math.abs(0.5 * ((this.refineLeft[i] as number) + (this.refineRight[i] as number)));
      if (mono > peak) peak = mono;
    }
    const threshold = ATTACK_START_FRACTION * peak;
    let at = 0;
    while (at < len - 1 && Math.abs(0.5 * ((this.refineLeft[at] as number) + (this.refineRight[at] as number))) < threshold) at++;
    return startFrame + at;
  }

  private add(h: number, strength: number): void {
    if (this.count >= MAX_ONSETS) return;
    const slot = h & REFINE_CACHE_MASK;
    let frame: number;
    if (this.refinedHop[slot] === h) {
      frame = this.refinedFrame[slot] as number;
    } else {
      frame = this.refine(h);
      this.refinedHop[slot] = h;
      this.refinedFrame[slot] = frame;
    }
    this.frames[this.count] = frame;
    this.strengths[this.count] = strength;
    this.count++;
  }

  /**
   * The attacks between two song positions into `frames` (frame of the attack) and `strengths` (how strong), ascending:
   * hops where the energy of the next ~10 ms is more than 8× that of the ~20 ms before, a run of such hops being one
   * attack (its strongest). The detector of the arrangement stretch (`detectOnsets`), but lazy and without a global
   * gate, so the same attack is found the same way from any frame that looks at it.
   */
  scan(from: number, to: number): void {
    this.count = 0;
    const hop = this.hop;
    const firstHop = Math.max(PRE_HOPS, Math.floor(from / hop) - LOOKBACK_HOPS);
    const lastHop = Math.floor(to / hop);
    let runBestHop = -1;
    let runStrength = 0;
    for (let h = firstHop; h <= lastHop; h++) {
      let before = 0;
      for (let j = 1; j <= PRE_HOPS; j++) before += this.energyOf(h - j);
      before /= PRE_HOPS;
      let after = 0;
      for (let j = 0; j < POST_HOPS; j++) after += this.energyOf(h + j);
      after /= POST_HOPS;
      if (after > GATE_MEAN_SQUARE && after > RISE_RATIO * before + RISE_FLOOR) {
        const strength = Math.sqrt(after) - Math.sqrt(before);
        if (strength > runStrength) {
          runStrength = strength;
          runBestHop = h;
        }
      } else if (runBestHop >= 0) {
        this.add(runBestHop, runStrength);
        runBestHop = -1;
        runStrength = 0;
      }
    }
    if (runBestHop >= 0) this.add(runBestHop, runStrength);
  }
}
