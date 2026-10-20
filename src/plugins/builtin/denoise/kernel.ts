import { at, EffectKernel, Fft, Readings, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import { denoiseFrames, type denoiseParams } from './params';

type Params = typeof denoiseParams;

/** The windows overlap four times: the hop is a quarter of a frame. */
const OVERLAP = 4;
/** A Hann window's four overlapped copies add up to 2. */
const WINDOW_SUM = 2;
/** Floor for powers, so a silent bin never divides by zero. */
const TINY = 1e-20;
/** Sensitivity (0–1) raises the noise by this many dB at 1. */
const SENSITIVITY_RANGE_DB = 6;
/** How much of the previous frame's result the gain estimate keeps; 0.965 at a 256-frame hop matches the offline 0.93 at 512. */
const MEMORY = 0.965;
/** The gain may fall by at most this many dB per second (a voice tail dies away instead of being gated off). */
const RELEASE_DB_PER_SECOND = 200;
/** Weight of each neighbouring bin when the gain is smoothed across frequency. */
const SIDE_WEIGHT = 0.2;
/** Without a learned noise: the tracked noise rises at most this fast (dB per second) and is trusted this much above its minimum. */
const TRACK_RISE_DB_PER_SECOND = 3;
const TRACK_MARGIN = 2.4;
/** The smoothing of the power the tracker watches: the share of the previous frames kept. */
const TRACK_SMOOTHING = 0.9;
/** Frames of silence kept before a learned noise is trusted (a learn switched on and off at once learns nothing). */
const MIN_LEARN_FRAMES = 8;
/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;

/** What the main thread keeps of a learned noise (the plugin's state): its power per bin in dB, for a transform of `frames`. */
export interface DenoiseState {
  profile?: readonly number[];
  frames?: number;
}

/** The message the kernel posts when a learn ends (preallocated: posting it allocates nothing on the audio thread). */
export interface ProfileMessage {
  type: 'profile';
  frames: number;
  /** Power per bin in dB (10·log10). */
  bins: Float32Array;
}

/**
 * Real-time noise reduction for monitoring and live input: the offline spectral gate's gain (see
 * `core/audio/cleanup/spectral-denoise.ts`) at 1024 samples per frame and a quarter-frame hop. The noise comes from a
 * learned profile (switch Learn on while only the room is heard, then off) or, before one is learned, from a tracker
 * that follows the quietest level each frequency reaches. The gain comes from the a priori signal-to-noise ratio, estimated
 * from what the last frame kept (so single frames do not flicker), is floored at −Reduction dB, smoothed across three bins
 * and may fall no faster than 200 dB per second. Both channels share the gain (one complex transform carries left and
 * right), so the stereo image does not move.
 *
 * Latency is one frame: the first sample of a hop leaves when the frame that completes its overlap-add has arrived.
 * Nothing allocates after construction.
 */
export class DenoiseKernel extends EffectKernel<Params> {
  private readonly size = denoiseFrames(this.sampleRate);
  private readonly hop = this.size / OVERLAP;
  private readonly bins = this.size / 2 + 1;
  private readonly mask = this.size - 1;
  private readonly fft = new Fft(this.size);
  private readonly window = new Float64Array(this.size);
  private readonly inputLeft = new Float32Array(this.size);
  private readonly inputRight = new Float32Array(this.size);
  private readonly sumLeft = new Float32Array(this.size);
  private readonly sumRight = new Float32Array(this.size);
  private readonly re = new Float64Array(this.size);
  private readonly im = new Float64Array(this.size);
  private readonly power = new Float64Array(this.bins);
  private readonly gain = new Float64Array(this.bins);
  /** The tracker's smoothed power per bin. */
  private readonly trackedPower = new Float64Array(this.bins);
  /** The gains of the last frame after smoothing and the limited fall: what multiplies the spectrum. */
  private readonly finalGain = new Float64Array(this.bins);
  private readonly released = new Float64Array(this.bins).fill(1);
  private readonly kept = new Float64Array(this.bins);
  /** The noise power per bin: the learned profile, or what the tracker has seen. */
  private readonly noise = new Float64Array(this.bins).fill(TINY);
  private readonly tracked = new Float64Array(this.bins);
  private readonly learnSum = new Float64Array(this.bins);
  private readonly profileMessage: ProfileMessage = { type: 'profile', frames: this.size, bins: new Float32Array(this.bins) };
  private readonly meter = new Readings(this.host, ['gr'] as const);
  private readonly releaseRatio = Math.pow(10, -(RELEASE_DB_PER_SECOND * (this.size / OVERLAP)) / this.sampleRate / 20);
  private readonly riseRatio = Math.pow(10, (TRACK_RISE_DB_PER_SECOND * (this.size / OVERLAP)) / this.sampleRate / 10);
  private position = 0;
  private sinceFrame = 0;
  private hasProfile = false;
  private wasLearning = false;
  private learnFrames = 0;
  private trackerReady = false;
  /** The mean of the last frame's gains over the bins (1 = nothing turned down). */
  private meanGain = 1;
  // The settings of the frame being made (read from the block's params at the frame).
  private floor = 1;
  private margin = 1;
  private reductionDb = 0;

  constructor(host: KernelHost) {
    super(host);
    for (let i = 0; i < this.size; i++) this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.size));
    const state = host.state as DenoiseState | undefined;
    if (state) this.setState(state);
  }

  /** The learned noise comes back with the project (or from an undo): its bins are mapped onto this transform's. */
  override setState(state: unknown): void {
    const saved = state as DenoiseState | null | undefined;
    const profile = saved?.profile;
    if (!profile || profile.length < 2) {
      this.hasProfile = false;
      this.trackerReady = false;
      return;
    }
    const fromBins = profile.length;
    for (let k = 0; k < this.bins; k++) {
      const source = Math.min(fromBins - 1, Math.round((k * (fromBins - 1)) / (this.bins - 1)));
      const db = profile[source] as number;
      this.noise[k] = Number.isFinite(db) ? Math.pow(10, db / 10) : TINY;
    }
    this.hasProfile = true;
  }

  override reset(): void {
    this.inputLeft.fill(0);
    this.inputRight.fill(0);
    this.sumLeft.fill(0);
    this.sumRight.fill(0);
    this.kept.fill(0);
    this.released.fill(1);
    this.tracked.fill(0);
    this.trackedPower.fill(0);
    this.trackerReady = false;
    this.meanGain = 1;
    this.position = 0;
    this.sinceFrame = 0;
    this.wasLearning = false;
    this.learnFrames = 0;
    this.learnSum.fill(0);
  }

  process(input: Float32Array[], output: Float32Array[], n: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? input[0]) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? output[0]) as Float32Array;
    const learning = (params.learn[0] as number) >= 0.5;
    const hearNoise = (params.listen[0] as number) >= 0.5;
    this.reductionDb = at(params.amount, 0);
    this.floor = Math.pow(10, -this.reductionDb / 20);
    this.margin = Math.pow(10, (SENSITIVITY_RANGE_DB * at(params.sensitivity, 0)) / 10);
    if (learning !== this.wasLearning) this.switchLearning(learning);
    const mask = this.mask;
    for (let i = 0; i < n; i++) {
      const slot = this.position;
      const dryLeft = this.inputLeft[slot] as number;
      const dryRight = this.inputRight[slot] as number;
      const wetLeft = this.sumLeft[slot] as number;
      const wetRight = this.sumRight[slot] as number;
      this.sumLeft[slot] = 0;
      this.sumRight[slot] = 0;
      outLeft[i] = hearNoise ? dryLeft - wetLeft : wetLeft;
      outRight[i] = hearNoise ? dryRight - wetRight : wetRight;
      this.inputLeft[slot] = inLeft[i] as number;
      this.inputRight[slot] = inRight[i] as number;
      this.position = (slot + 1) & mask;
      if (++this.sinceFrame === this.hop) {
        this.sinceFrame = 0;
        this.makeFrame(learning);
      }
    }
    this.meter.values.gr = this.reductionDb > 0 ? this.averageReductionDb() : 0;
    this.meter.tick(n);
  }

  /** Learn went on or off: starting clears the sum, stopping turns the sum into the noise and tells the main thread. */
  private switchLearning(learning: boolean): void {
    this.wasLearning = learning;
    if (learning) {
      this.learnSum.fill(0);
      this.learnFrames = 0;
      return;
    }
    if (this.learnFrames < MIN_LEARN_FRAMES) return;
    const bins = this.bins;
    const scale = 1 / this.learnFrames;
    const out = this.profileMessage.bins;
    for (let k = 0; k < bins; k++) {
      const left = this.learnSum[Math.max(0, k - 1)] as number;
      const right = this.learnSum[Math.min(bins - 1, k + 1)] as number;
      const mean = (0.25 * left + 0.5 * (this.learnSum[k] as number) + 0.25 * right) * scale;
      this.noise[k] = Math.max(mean, TINY);
      out[k] = 10 * Math.log10(this.noise[k] as number);
    }
    this.hasProfile = true;
    this.kept.fill(0);
    this.host.post(this.profileMessage);
  }

  /** Transforms the last frame, finds the gains and overlap-adds the result into the output sums. */
  private makeFrame(learning: boolean): void {
    const size = this.size;
    const mask = this.mask;
    const re = this.re;
    const im = this.im;
    const window = this.window;
    // The oldest sample of the frame is at the write position (the ring holds exactly one frame).
    for (let i = 0; i < size; i++) {
      const at = (this.position + i) & mask;
      re[i] = (this.inputLeft[at] as number) * (window[i] as number);
      im[i] = (this.inputRight[at] as number) * (window[i] as number);
    }
    this.fft.forward(re, im);
    this.measurePower();
    if (learning) this.addToLearning();
    if (!this.hasProfile) this.trackNoise();
    this.findGains();
    this.applyGains();
    this.overlapAdd();
  }

  /** Mean power of the two channels per bin, from the one complex transform that carries both. */
  private measurePower(): void {
    const size = this.size;
    const re = this.re;
    const im = this.im;
    const power = this.power;
    for (let k = 0; k < this.bins; k++) {
      const mirror = k === 0 ? 0 : size - k;
      const a = re[k] as number;
      const b = im[k] as number;
      const c = re[mirror] as number;
      const d = im[mirror] as number;
      // left = (Z[k] + conj Z[N−k]) / 2, right = (Z[k] − conj Z[N−k]) / 2i.
      const leftRe = (a + c) * 0.5;
      const leftIm = (b - d) * 0.5;
      const rightRe = (b + d) * 0.5;
      const rightIm = (c - a) * 0.5;
      power[k] = 0.5 * (leftRe * leftRe + leftIm * leftIm + rightRe * rightRe + rightIm * rightIm);
    }
  }

  private addToLearning(): void {
    for (let k = 0; k < this.bins; k++) this.learnSum[k] = (this.learnSum[k] as number) + (this.power[k] as number);
    this.learnFrames++;
  }

  /** The tracker: a smoothed power that may fall at once and rise slowly, kept as the noise (with a margin for its dips). */
  private trackNoise(): void {
    const tracked = this.tracked;
    for (let k = 0; k < this.bins; k++) {
      const p = this.power[k] as number;
      if (!this.trackerReady) {
        this.trackedPower[k] = p;
        tracked[k] = p;
      } else {
        const smooth = TRACK_SMOOTHING * (this.trackedPower[k] as number) + (1 - TRACK_SMOOTHING) * p;
        this.trackedPower[k] = smooth;
        const risen = (tracked[k] as number) * this.riseRatio;
        tracked[k] = smooth < risen ? smooth : risen;
      }
      this.noise[k] = Math.max((tracked[k] as number) * TRACK_MARGIN, TINY);
    }
    this.trackerReady = true;
  }

  /** The Wiener gain per bin from the a priori signal-to-noise ratio, floored, smoothed across bins and limited in how fast it falls. */
  private findGains(): void {
    const bins = this.bins;
    const gain = this.gain;
    const finalGain = this.finalGain;
    for (let k = 0; k < bins; k++) {
      const noise = (this.noise[k] as number) * this.margin;
      const p = this.power[k] as number;
      const snrNow = Math.max(p / noise - 1, 0);
      const snr = MEMORY * ((this.kept[k] as number) / noise) + (1 - MEMORY) * snrNow;
      const g = Math.max(snr / (1 + snr), this.floor);
      gain[k] = g;
      this.kept[k] = g * g * p;
    }
    // Across three bins, then limit the fall.
    let left = gain[0] as number;
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const mid = gain[k] as number;
      const right = gain[Math.min(bins - 1, k + 1)] as number;
      const blended = SIDE_WEIGHT * left + (1 - 2 * SIDE_WEIGHT) * mid + SIDE_WEIGHT * right;
      left = mid;
      const g = Math.max(blended, (this.released[k] as number) * this.releaseRatio, this.floor);
      this.released[k] = g;
      finalGain[k] = g;
      sum += g;
    }
    this.meanGain = sum / bins;
  }

  /** Multiplies the spectrum by the (real, symmetric) gains and brings it back to the time domain (by the conjugate trick: the forward transform of the conjugate). */
  private applyGains(): void {
    const size = this.size;
    const re = this.re;
    const im = this.im;
    const gains = this.finalGain;
    for (let k = 0; k < this.bins; k++) {
      const g = gains[k] as number;
      re[k] = (re[k] as number) * g;
      im[k] = -(im[k] as number) * g;
      if (k > 0 && k < size - k) {
        re[size - k] = (re[size - k] as number) * g;
        im[size - k] = -(im[size - k] as number) * g;
      }
    }
    this.fft.forward(re, im);
  }

  /** Adds the windowed frame (left in the real part, right in the negated imaginary part, both scaled) to the output sums. */
  private overlapAdd(): void {
    const size = this.size;
    const mask = this.mask;
    const scale = 1 / (size * WINDOW_SUM);
    for (let i = 0; i < size; i++) {
      const at = (this.position + i) & mask;
      const w = (this.window[i] as number) * scale;
      this.sumLeft[at] = (this.sumLeft[at] as number) + (this.re[i] as number) * w;
      this.sumRight[at] = (this.sumRight[at] as number) - (this.im[i] as number) * w;
    }
  }

  /** Reduction of the last frame's mean gain (dB, ≥ 0), for the meter: one logarithm per block. */
  private averageReductionDb(): number {
    return Math.max(0, -DB_PER_NEPER * Math.log(this.meanGain));
  }
}
