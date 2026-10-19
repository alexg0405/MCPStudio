import {
  InstrumentKernel,
  VoicePool,
  at,
  mtof,
  type KernelHost,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import type { pluckParams } from './params';

const MAX_LOOP_FRAMES = 4096;
/** Seconds of sound a pluck's level is judged over. */
const LEVEL_SEC = 1;
/** Terms of the Chebyshev fit of the level weight (see levelBurst). */
const LEVEL_DEGREE = 16;
/** Long bursts (low notes) have a flatter weight, so they need fewer terms. */
const LEVEL_DEGREE_LONG = 6;
/** Bursts longer than this (low notes) use LEVEL_DEGREE_LONG. */
const LONG_BURST_SAMPLES = 512;
const LEVEL_NODES = LEVEL_DEGREE + 1;
/** Bursts up to this many samples have their level summed bin by bin (see levelBurst). */
const EXACT_BELOW_SAMPLES = 160;
/** cos(π·d·(j+½)/M) for the fit's basis, computed once: row d, node j. */
const CHEBYSHEV_COSINES = (() => {
  const t = new Float64Array(LEVEL_NODES * LEVEL_NODES);
  for (let d = 0; d < LEVEL_NODES; d++)
    for (let j = 0; j < LEVEL_NODES; j++) t[d * LEVEL_NODES + j] = Math.cos((Math.PI * d * (j + 0.5)) / LEVEL_NODES);
  return t;
})();

class PluckVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  delayLine = new Float32Array(MAX_LOOP_FRAMES);
  loopLength = 1;
  readPosition = 0;
  /** The burst still needs its level set (done on the first block, when the decay params are known). */
  needsLevelSet = false;
  /** One-pole coefficient the burst was drawn with. */
  burstSmoothing = 1;
  /** One-pole low-pass state in the loop. */
  lowpassState = 0;
  /** First-order all-pass (fractional delay) state. */
  allpassInput = 0;
  allpassOutput = 0;
  allpassCoefficient = 0;
  frequencyHz = 440;
  velocity = 0;
  pan = 0;
  quietFrames = 0;
}

/**
 * Karplus-Strong plucked string. Built as a worklet kernel because a native Web Audio feedback
 * loop can't be shorter than one 128-frame block (anything above ~375 Hz would be impossible).
 */
export class PluckKernel extends InstrumentKernel<typeof pluckParams> {
  private readonly pool = new VoicePool(16, () => new PluckVoice());
  /** Scratch for levelBurst, allocated once. */
  private readonly nodeWeights = new Float64Array(LEVEL_NODES);
  private readonly chebyshevCoefficients = new Float64Array(LEVEL_NODES);
  private readonly rootCosines = new Float64Array(EXACT_BELOW_SAMPLES + 1);
  private readonly rootSines = new Float64Array(EXACT_BELOW_SAMPLES + 1);
  /** What the last level measurement found: the burst's actual level and its expected value. */
  private measuredLevel = 0;
  private expectedLevel = 0;

  constructor(host: KernelHost) {
    super(host);
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    const voice = this.pool.start(noteId, key);
    const sampleRate = this.sampleRate;
    // A string's length is fixed while it rings: the note's fine pitch and the channel pitch apply at the pluck.
    voice.frequencyHz = mtof(key + (fine + at(this.pitch, 0)) / 100);
    // Loop delay = N (buffer) + 0.5 (averaging filter) + d (all-pass) = sr / f.
    const loopDelayFrames = Math.min(MAX_LOOP_FRAMES - 1, sampleRate / voice.frequencyHz);
    const wholeFrames = Math.max(2, Math.floor(loopDelayFrames - 0.5 - 0.01));
    const fraction = loopDelayFrames - 0.5 - wholeFrames;
    voice.loopLength = wholeFrames;
    voice.allpassCoefficient = (1 - fraction) / (1 + fraction);
    voice.allpassInput = 0;
    voice.allpassOutput = 0;
    voice.readPosition = 0;
    voice.lowpassState = 0;
    voice.velocity = velocity;
    voice.pan = pan;
    voice.quietFrames = 0;
    // Excite with filtered noise; `tone` sets the brightness of the pick.
    const tone = this.lastTone;
    const burstSmoothing = 0.05 + 0.95 * tone;
    let filteredNoise = 0;
    let mean = 0;
    for (let i = 0; i < wholeFrames; i++) {
      filteredNoise += burstSmoothing * (this.host.rand() * 2 - 1 - filteredNoise);
      voice.delayLine[i] = filteredNoise;
      mean += filteredNoise;
    }
    mean /= wholeFrames;
    for (let i = 0; i < wholeFrames; i++) voice.delayLine[i] = (voice.delayLine[i] as number) - mean;
    voice.needsLevelSet = true;
    voice.burstSmoothing = burstSmoothing;
  }

  /**
   * Scales a new burst so the pluck's loudness doesn't depend on the random draw. Each harmonic of
   * the burst has a random power (exponentially distributed), and the level is the sum over the
   * harmonics weighted by how much of each one survives the loop over LEVEL_SEC. Summing the
   * random parts swings the level by several dB from seed to seed (most at high pitches, where few
   * harmonics are left). Scale the burst so that sum equals its expected value for this tone.
   *
   * The weight of harmonic k is w(cos 2πk/n). Short bursts (up to EXACT_BELOW_SAMPLES samples) sum the bins
   * one by one. Longer ones fit w with a Chebyshev series, so the sum over the bins needs only the
   * burst's circular autocorrelation at a few lags (cos(d·w_k) summed over the bins is n times that
   * lag's value): LEVEL_DEGREE lags up to LONG_BURST_SAMPLES samples, LEVEL_DEGREE_LONG beyond, which is
   * the flatter weight of a low note (fewer periods per second). The expected value comes from the
   * tone filter's autocorrelation in closed form, so a long burst costs a handful of passes over it,
   * once per note (about 130 µs for eight notes at keys 24 to 31; test/unit/pluck-cost.test.ts holds
   * that to a budget).
   */
  private levelBurst(voice: PluckVoice, t60Sec: number, damping: number): void {
    const burstLength = voice.loopLength;
    const burst = voice.delayLine;
    const smoothing = voice.burstSmoothing;
    const periods = LEVEL_SEC * voice.frequencyHz;
    // Energy per loop period of harmonic k is g² · (|averaging filter| at its frequency)², which is
    // g² (A + B·cos w) with A and B from the damping.
    const loopPowerGain = Math.pow(10, -6 / (t60Sec * voice.frequencyHz));
    const filterPowerOffset = (1 - damping) * (1 - damping) + damping * damping;
    const filterPowerCosine = 2 * damping * (1 - damping);
    if (burstLength <= EXACT_BELOW_SAMPLES) {
      this.levelByBins(burst, burstLength, smoothing, periods, loopPowerGain, filterPowerOffset, filterPowerCosine);
    } else {
      this.levelByChebyshev(
        burst,
        burstLength,
        smoothing,
        periods,
        loopPowerGain,
        filterPowerOffset,
        filterPowerCosine,
      );
    }
    const actual = this.measuredLevel;
    if (actual > 1e-20) {
      const gain = Math.sqrt(this.expectedLevel / actual);
      for (let i = 0; i < burstLength; i++) burst[i] = (burst[i] as number) * gain;
    }
  }

  /**
   * The burst's actual and expected level for a short burst: its harmonics summed bin by bin. Leaves them in
   * `measuredLevel` and `expectedLevel`.
   */
  private levelByBins(
    burst: Float32Array,
    burstLength: number,
    smoothing: number,
    periods: number,
    loopPowerGain: number,
    filterPowerOffset: number,
    filterPowerCosine: number,
  ): void {
    let actual = 0;
    let expected = 0;
    // The n-th roots of unity, once per note: bin k of the burst is Σ x_i·e^{−2πjki/n}.
    const rootCos = this.rootCosines;
    const rootSin = this.rootSines;
    for (let root = 0; root < burstLength; root++) {
      const angle = (2 * Math.PI * root) / burstLength;
      rootCos[root] = Math.cos(angle);
      rootSin[root] = Math.sin(angle);
    }
    // Bins k and n−k carry the same power and weight, so half the bins (counted twice) suffice.
    for (let bin = 1; 2 * bin <= burstLength; bin++) {
      const cosineOfBin = rootCos[bin] as number;
      const energyPerPeriod = loopPowerGain * (filterPowerOffset + filterPowerCosine * cosineOfBin);
      const weight = (1 - Math.pow(energyPerPeriod, periods)) / (1 - energyPerPeriod);
      let rootIndex = 0;
      let realPart = 0;
      let imaginaryPart = 0;
      for (let i = 0; i < burstLength; i++) {
        const sample = burst[i] as number;
        realPart += sample * (rootCos[rootIndex] as number);
        imaginaryPart -= sample * (rootSin[rootIndex] as number);
        rootIndex += bin;
        if (rootIndex >= burstLength) rootIndex -= burstLength;
      }
      const expectedBinPower =
        (smoothing * smoothing) / (1 - 2 * (1 - smoothing) * cosineOfBin + (1 - smoothing) * (1 - smoothing));
      const binMultiplicity = 2 * bin === burstLength ? 1 : 2;
      actual += binMultiplicity * weight * (realPart * realPart + imaginaryPart * imaginaryPart);
      expected += binMultiplicity * weight * expectedBinPower;
    }
    expected *= burstLength / 3;
    this.measuredLevel = actual;
    this.expectedLevel = expected;
  }

  /**
   * The same for a long burst: the weight fitted with a Chebyshev series, the sum over the bins taken from the
   * burst's autocorrelation at a few lags. Leaves the levels in `measuredLevel` and `expectedLevel`.
   */
  private levelByChebyshev(
    burst: Float32Array,
    burstLength: number,
    smoothing: number,
    periods: number,
    loopPowerGain: number,
    filterPowerOffset: number,
    filterPowerCosine: number,
  ): void {
    let actual = 0;
    const nodeCount = LEVEL_NODES;
    const nodeWeights = this.nodeWeights;
    const chebyshevCoefficients = this.chebyshevCoefficients;
    // Chebyshev interpolation of the weight at the M nodes x_j = cos(π(j+½)/M).
    for (let j = 0; j < nodeCount; j++) {
      const e = loopPowerGain * (filterPowerOffset + filterPowerCosine * (CHEBYSHEV_COSINES[nodeCount + j] as number));
      nodeWeights[j] = (1 - Math.pow(e, periods)) / (1 - e);
    }
    const degree = burstLength > LONG_BURST_SAMPLES ? LEVEL_DEGREE_LONG : LEVEL_DEGREE;
    for (let d = 0; d <= degree; d++) {
      let sum = 0;
      for (let j = 0; j < nodeCount; j++)
        sum += (nodeWeights[j] as number) * (CHEBYSHEV_COSINES[d * nodeCount + j] as number);
      chebyshevCoefficients[d] = ((d === 0 ? 1 : 2) / nodeCount) * sum;
    }
    // The burst's circular autocorrelation at lags 0..deg, weighted by the fit.
    for (let d = 0; d <= degree; d++) {
      let autocorrelation = 0;
      for (let i = d; i < burstLength; i++) autocorrelation += (burst[i] as number) * (burst[i - d] as number);
      for (let i = 0; i < d; i++) autocorrelation += (burst[i] as number) * (burst[i - d + burstLength] as number);
      actual += (chebyshevCoefficients[d] as number) * autocorrelation;
    }
    actual *= burstLength;
    // Expected value. For the tone filter's autocorrelation r(d) = a/(2−a)·(1−a)^d/3 the burst's
    // lag sums are E[C'(d)] = (n−d)·r(d) − E[(Σb)²]/n, where E[(Σb)²] = n/3 − (2/3)(1−a)/(a(2−a))
    // (the mean removed from the burst is the lag sums' −E[(Σb)²]/n term).
    const smoothingDecay = 1 - smoothing;
    const lagZeroValue = smoothing / (2 - smoothing) / 3;
    const expectedSumSquares = burstLength / 3 - (2 / 3) * (smoothingDecay / (smoothing * (2 - smoothing)));
    let expectedLagSum = 0;
    let coefficientSum = 0;
    let rhoPower = 1;
    for (let d = 0; d <= degree; d++) {
      expectedLagSum += (chebyshevCoefficients[d] as number) * (burstLength - d) * lagZeroValue * rhoPower;
      coefficientSum += chebyshevCoefficients[d] as number;
      rhoPower *= smoothingDecay;
    }
    const expected = burstLength * expectedLagSum - expectedSumSquares * coefficientSum;
    this.measuredLevel = actual;
    this.expectedLevel = expected;
  }

  noteOff(noteId: number): void {
    this.pool.release(noteId);
  }

  override allNotesOff(hard: boolean): void {
    if (hard) this.pool.freeAll();
    else this.pool.releaseAll();
  }

  override reset(): void {
    this.pool.freeAll();
  }

  private lastTone = 0.6;

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<typeof pluckParams>): void {
    const left = out[0] as Float32Array;
    const right = (out[1] ?? out[0]) as Float32Array;
    const sampleRate = this.sampleRate;
    this.lastTone = at(params.tone, from);
    const decay = at(params.decay, from);
    const release = at(params.release, from);
    const damping = at(params.damping, from);
    const width = at(params.width, from);
    const level = Math.pow(10, at(params.level, from) / 20);
    const voices = this.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as PluckVoice;
      if (!voice.active) continue;
      // Loop gain per period for a T60 of `decay` (or `release` once released).
      const t60 = voice.releasing ? Math.min(release, decay) : decay;
      const loopGain = Math.pow(10, -3 / (t60 * voice.frequencyHz));
      const averagingBlend = 0.5 + 0.49 * damping;
      if (voice.needsLevelSet) {
        voice.needsLevelSet = false;
        this.levelBurst(voice, t60, averagingBlend);
      }
      const pan = Math.max(-1, Math.min(1, voice.pan + (((voice.key * 7) % 12) / 11 - 0.5) * width));
      const leftGain = voice.velocity * level * Math.sqrt(0.5 * (1 - pan));
      const rightGain = voice.velocity * level * Math.sqrt(0.5 * (1 + pan));
      let peak = 0;
      for (let i = from; i < to; i++) {
        const sample = voice.delayLine[voice.readPosition] as number;
        // Averaging low-pass (half-sample delay) blended with damping, then fractional all-pass.
        const averaged = sample + averagingBlend * (voice.lowpassState - sample);
        voice.lowpassState = sample;
        const allpassed =
          voice.allpassCoefficient * averaged + voice.allpassInput - voice.allpassCoefficient * voice.allpassOutput;
        voice.allpassInput = averaged;
        voice.allpassOutput = allpassed;
        let feedback = allpassed * loopGain;
        if (!(Math.abs(feedback) > 1e-20)) feedback = 0;
        voice.delayLine[voice.readPosition] = feedback;
        voice.readPosition = voice.readPosition + 1 === voice.loopLength ? 0 : voice.readPosition + 1;
        left[i] = (left[i] as number) + sample * leftGain;
        right[i] = (right[i] as number) + sample * rightGain;
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
      }
      // Free voices that have died away.
      voice.quietFrames = peak < 1e-4 ? voice.quietFrames + (to - from) : 0;
      if (voice.quietFrames > sampleRate * 0.05) this.pool.free(voice);
    }
  }
}
