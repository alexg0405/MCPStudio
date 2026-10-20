/**
 * Offline noise reduction: a Wiener-style spectral gate with smoothing, so a steady hiss, hum or room tone goes down
 * without the "birdie" bursts that plain spectral subtraction leaves behind. Pure and deterministic (no DOM, no
 * random), so it runs in a Worker and in Node tests.
 *
 * How it works (short-time transform of 2048 samples at 48 kHz, hop a quarter frame, square-root Hann windows):
 *  1. The noise profile (`noise-profile.ts`) says how much power each frequency has in the noise alone. The
 *     "sensitivity" raises it by 0 to 6 dB: how far above the noise a sound must rise to be kept.
 *  2. Each frame's gain per frequency comes from the a priori signal-to-noise ratio, estimated "decision-directed"
 *     (Ephraim and Malah, 1984): mostly from what the previous frame kept, a little from this frame. That memory
 *     is what stops single frames from flickering in and out. The gain is the Wiener gain ξ/(1 + ξ), never below
 *     the "amount" (a gain floor of −amountDb), so the noise goes down by about that much and no further.
 *  3. Musical noise is a gain that is high in one small patch of time and frequency only. A patch that is narrow in
 *     time AND narrow in frequency is lowered to its surroundings (grey-scale opening in both directions, kept where
 *     either direction is wide, so a consonant's burst and a long partial both stay), then the gain is smoothed
 *     across three bins and may fall no faster than `RELEASE_DB_PER_SECOND`.
 *  4. The gains multiply every channel's spectrum (the voice and its stereo image are left alone; the gains are
 *     found from the mix of the channels, or from `gainsFrom`), and overlap-add rebuilds the sound.
 * It works in chunks of frames with a little look-ahead, so memory stays flat for any length.
 */
import { RealFFT } from '../../voice/fft';
import { monoOf, sqrtHannWindow, type NoiseProfile } from './noise-profile';

/** How much the noise can be turned down at most (dB). */
export const DENOISE_MAX_DB = 30;
/** Sensitivity (0–1) raises the learned noise by this many dB at 1. */
const SENSITIVITY_RANGE_DB = 6;
/** How much of the previous frame's result the decision-directed estimate keeps (0–1). */
const MEMORY = 0.93;
/** The gain may fall by at most this many dB per second (a voice tail dies away instead of being gated off). */
const RELEASE_DB_PER_SECOND = 200;
/** Weight of each neighbouring bin when the gain is smoothed across frequency (the middle bin keeps the rest). */
const SIDE_WEIGHT = 0.2;
/** Frames computed per chunk: sets the memory used, not the result. */
const CHUNK_FRAMES = 96;
/** Frames of look-ahead the time smoothing needs on each side. */
const LOOK = 2;
/** The windows overlap four times, which sums to 2 for a Hann window. */
const OVERLAP = 4;
const WINDOW_SUM = 2;
/** Floor for powers, so a silent bin never divides by zero. */
const TINY = 1e-20;

/** What the noise reduction is asked for. */
export interface DenoiseSettings {
  /** The most the noise is turned down, dB (0–30). */
  amountDb: number;
  /** 0–1: how far above the noise a sound must rise to be kept (0 gentle, 1 firm). */
  sensitivity: number;
}

/** Extras for one run. */
export interface DenoiseOptions {
  /** A mono signal to find the gains in instead of the mix of the channels (the tests use it to measure speech and noise apart). */
  gainsFrom?: Float32Array;
  /** Called now and then with 0..1. */
  onProgress?: (fraction: number) => void;
}

/** The gain a frame's sound is never turned down below, linear. */
export function gainFloor(amountDb: number): number {
  return Math.pow(10, -Math.min(DENOISE_MAX_DB, Math.max(0, amountDb)) / 20);
}

/** The decision-directed Wiener gain of every bin, frame after frame (the part that remembers). */
class GainEstimator {
  private readonly noise: Float64Array;
  private readonly kept: Float64Array;
  private readonly floor: number;

  constructor(profile: NoiseProfile, settings: DenoiseSettings) {
    const margin = Math.pow(10, (SENSITIVITY_RANGE_DB * Math.min(1, Math.max(0, settings.sensitivity))) / 10);
    this.noise = profile.power.map((v) => Math.max(v * margin, TINY));
    this.kept = new Float64Array(this.noise.length);
    this.floor = gainFloor(settings.amountDb);
  }

  /** The gains for one frame of powers `power` (per bin) into `out`. */
  step(power: Float64Array, out: Float32Array): void {
    const { noise, kept, floor } = this;
    for (let k = 0; k < noise.length; k++) {
      const n = noise[k] as number;
      const p = power[k] as number;
      const snrNow = Math.max(p / n - 1, 0);
      const snr = MEMORY * ((kept[k] as number) / n) + (1 - MEMORY) * snrNow;
      const gain = Math.max(snr / (1 + snr), floor);
      out[k] = gain;
      kept[k] = gain * gain * p;
    }
  }
}

/**
 * Cleans `channels` with the noise `profile` (it must come from audio of the same rate). Every channel is cut to its
 * own length; the result has the same lengths. Amount 0 returns copies of the input.
 */
export function denoiseChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  profile: NoiseProfile,
  settings: DenoiseSettings,
  options: DenoiseOptions = {},
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || settings.amountDb <= 0) return channels.map((c) => Float32Array.from(c));
  const size = profile.frameSize;
  const hop = size / OVERLAP;
  const frameCount = Math.floor((length - 1) / hop) + 1 + (OVERLAP - 1);
  const analysis = options.gainsFrom ?? monoOf(channels);
  const run = new Run(analysis, sampleRate, profile, settings, frameCount);
  const outputs = channels.map(() => new Float32Array(length));
  for (let first = 0; first < frameCount; first += CHUNK_FRAMES) {
    const last = Math.min(frameCount, first + CHUNK_FRAMES);
    run.gainsFor(first, last);
    channels.forEach((channel, c) => run.apply(channel, outputs[c] as Float32Array, first, last));
    options.onProgress?.(last / frameCount);
  }
  return outputs;
}

/** The state of one run: transforms, the raw gains of the frames near the chunk and the smoothing's memory. */
class Run {
  private readonly size: number;
  private readonly hop: number;
  private readonly bins: number;
  private readonly fft: RealFFT;
  private readonly window: Float64Array;
  private readonly estimator: GainEstimator;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly power: Float64Array;
  /** Raw gains of frames [rawFirst, rawFirst + rawCount) laid out frame after frame. */
  private raw: Float32Array;
  private rawFirst = 0;
  private rawCount = 0;
  /** The gains of the chunk's frames after smoothing (frame after frame). */
  private readonly final: Float32Array;
  private readonly released: Float32Array;
  private readonly releaseRatio: number;
  private readonly floor: number;
  private readonly rowScratch: Float32Array;

  constructor(
    private readonly analysis: Float32Array,
    sampleRate: number,
    profile: NoiseProfile,
    settings: DenoiseSettings,
    private readonly frameCount: number,
  ) {
    this.size = profile.frameSize;
    this.hop = this.size / OVERLAP;
    this.bins = this.size / 2 + 1;
    this.fft = new RealFFT(this.size);
    this.window = sqrtHannWindow(this.size);
    this.estimator = new GainEstimator(profile, settings);
    this.re = new Float64Array(this.bins);
    this.im = new Float64Array(this.bins);
    this.power = new Float64Array(this.bins);
    this.raw = new Float32Array((CHUNK_FRAMES + 2 * LOOK) * this.bins);
    this.final = new Float32Array(CHUNK_FRAMES * this.bins);
    this.released = new Float32Array(this.bins).fill(1);
    this.rowScratch = new Float32Array(this.bins);
    this.releaseRatio = Math.pow(10, -(RELEASE_DB_PER_SECOND * this.hop) / sampleRate / 20);
    this.floor = gainFloor(settings.amountDb);
  }

  /** Where frame `m` starts in a signal (the first frames hang over the start so every sample has all four windows). */
  private start(m: number): number {
    return (m - (OVERLAP - 1)) * this.hop;
  }

  /** Windows and transforms `signal`'s frame `m` into `re`/`im`. */
  private transform(signal: Float32Array, m: number): void {
    const frame = this.fft.frame;
    const from = this.start(m);
    const window = this.window;
    for (let i = 0; i < this.size; i++) {
      const at = from + i;
      frame[i] = at >= 0 && at < signal.length ? (signal[at] as number) * (window[i] as number) : 0;
    }
    this.fft.forward(frame, this.re, this.im);
  }

  /** Smoothed gains of frames [first, last) into `final`. */
  gainsFor(first: number, last: number): void {
    this.extendRaw(first, last);
    for (let m = first; m < last; m++) this.smooth(m, (m - first) * this.bins);
  }

  /** Raw gains for the frames from `first - LOOK` to `last + LOOK` (the ones kept from the chunk before are not made again). */
  private extendRaw(first: number, last: number): void {
    const bins = this.bins;
    const wantFirst = Math.max(0, first - LOOK);
    const wantEnd = Math.min(this.frameCount, last + LOOK);
    if (this.rawCount === 0) {
      this.rawFirst = wantFirst;
    } else if (wantFirst > this.rawFirst) {
      const kept = Math.max(0, this.rawFirst + this.rawCount - wantFirst);
      const from = (wantFirst - this.rawFirst) * bins;
      this.raw.copyWithin(0, from, from + kept * bins);
      this.rawFirst = wantFirst;
      this.rawCount = kept;
    }
    for (let m = this.rawFirst + this.rawCount; m < wantEnd; m++) {
      this.transform(this.analysis, m);
      for (let k = 0; k < bins; k++) this.power[k] = (this.re[k] as number) ** 2 + (this.im[k] as number) ** 2;
      this.estimator.step(this.power, this.rowScratch);
      this.raw.set(this.rowScratch, (m - this.rawFirst) * bins);
      this.rawCount++;
    }
  }

  /** The raw gain row of frame `m` (frames beyond either end repeat the nearest one) as an offset into `raw`. */
  private rowOf(m: number): number {
    const clamped = Math.min(this.frameCount - 1, Math.max(0, m));
    return (clamped - this.rawFirst) * this.bins;
  }

  /** One frame's final gains: patches isolated in time and frequency lowered, smoothed across bins, with a limited fall. */
  private smooth(m: number, target: number): void {
    const inTime = this.rowScratch;
    this.openInTime(m, inTime);
    this.keepWhereEitherOpeningHolds(m, inTime, target);
    this.smoothAndLimitFall(target);
  }

  /** Opening in time of frame `m`'s raw gains: the smallest over three frames, then the largest of three such minima (a patch of one or two frames goes). */
  private openInTime(m: number, out: Float32Array): void {
    const raw = this.raw;
    const a = this.rowOf(m - 2);
    const b = this.rowOf(m - 1);
    const c = this.rowOf(m);
    const d = this.rowOf(m + 1);
    const e = this.rowOf(m + 2);
    for (let k = 0; k < this.bins; k++) {
      const twoBefore = raw[a + k] as number;
      const before = raw[b + k] as number;
      const now = raw[c + k] as number;
      const after = raw[d + k] as number;
      const twoAfter = raw[e + k] as number;
      const minBefore = Math.min(twoBefore, before, now);
      const minHere = Math.min(before, now, after);
      const minAfter = Math.min(now, after, twoAfter);
      out[k] = Math.max(minBefore, minHere, minAfter);
    }
  }

  /**
   * Opening in frequency of frame `m`, then for every bin the larger of that and the opening in time (`inTime`): a patch that
   * is wide in either direction survives, one that is narrow in both is lowered. Written to `final` at `target`.
   */
  private keepWhereEitherOpeningHolds(m: number, inTime: Float32Array, target: number): void {
    const bins = this.bins;
    const raw = this.raw;
    const now = this.rowOf(m);
    for (let k = 0; k < bins; k++) {
      let widest = 0;
      for (let j = Math.max(0, k - 1); j <= Math.min(bins - 1, k + 1); j++) {
        const eroded = Math.min(
          raw[now + Math.max(0, j - 1)] as number,
          raw[now + j] as number,
          raw[now + Math.min(bins - 1, j + 1)] as number,
        );
        widest = Math.max(widest, eroded);
      }
      this.final[target + k] = Math.max(inTime[k] as number, widest);
    }
  }

  /** Smooths the gains at `target` across three bins and lets them fall no faster than the release allows (and never below the floor). */
  private smoothAndLimitFall(target: number): void {
    const bins = this.bins;
    const gain = this.final;
    let left = gain[target] as number;
    for (let k = 0; k < bins; k++) {
      const mid = gain[target + k] as number;
      const right = gain[target + Math.min(bins - 1, k + 1)] as number;
      const smoothed = SIDE_WEIGHT * left + (1 - 2 * SIDE_WEIGHT) * mid + SIDE_WEIGHT * right;
      left = mid;
      const g = Math.max(smoothed, (this.released[k] as number) * this.releaseRatio, this.floor);
      this.released[k] = g;
      gain[target + k] = g;
    }
  }

  /** Multiplies `channel`'s frames [first, last) by their gains and overlap-adds them into `output`. */
  apply(channel: Float32Array, output: Float32Array, first: number, last: number): void {
    const bins = this.bins;
    const frame = this.fft.frame;
    const window = this.window;
    const scale = 1 / WINDOW_SUM;
    for (let m = first; m < last; m++) {
      this.transform(channel, m);
      const at = (m - first) * bins;
      for (let k = 0; k < bins; k++) {
        const g = this.final[at + k] as number;
        this.re[k] = (this.re[k] as number) * g;
        this.im[k] = (this.im[k] as number) * g;
      }
      this.fft.inverse(this.re, this.im, frame);
      const from = this.start(m);
      for (let i = 0; i < this.size; i++) {
        const to = from + i;
        if (to >= 0 && to < output.length) output[to] = (output[to] as number) + (frame[i] as number) * (window[i] as number) * scale;
      }
    }
  }
}
