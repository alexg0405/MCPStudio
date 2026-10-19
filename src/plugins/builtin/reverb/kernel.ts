import { EffectKernel, flush, type ParamBlock } from '@agstudio/sdk/worklet';
import type { reverbParams } from './params';
import {
  CONTROL_FRAMES,
  DIFFUSER_GAINS,
  DIFFUSER_MS,
  DIFFUSERS_PER_SIDE,
  DRIFT_DEPTH_MS,
  DRIFT_RATES_HZ,
  ENERGY_POINTS,
  HIGH_BAND_DAMPING,
  HIGH_BAND_HZ,
  HIGH_BAND_LEVEL,
  IDLE_GATE_SEC,
  LINE_COUNT,
  LINE_MS,
  LINEAR_READ_ABOVE_STEP,
  LN_1000,
  LONGEST_LINE_MS,
  LOOP_ALLPASS_GAIN,
  LOOP_ALLPASS_MS,
  LOW_BAND_HZ,
  LOW_BAND_RATIO,
  MAX_GLIDE_STEP,
  MAX_PRE_DELAY_SEC,
  MIN_SIZE_SCALE,
  PARAM_SMOOTH_SEC,
  powerOfTwoAtLeast,
  shelfInto,
  shelfPower,
  SILENT_LEVEL,
  SIZE_SMOOTH_SEC,
  TAIL_FLOOR,
} from './tuning.kernel';

type Params = typeof reverbParams;

const HALF_PI = Math.PI / 2;
/** Coefficients each line keeps in `shelfCoefficients`: low shelf b0, b1 and high shelf b0, b1. */
const COEFFICIENTS_PER_LINE = 4;
/** Where the input shelf's two coefficients are kept: in the slots after the lines'. */
const INPUT_SHELF_AT = COEFFICIENTS_PER_LINE * LINE_COUNT;

/**
 * Algorithmic stereo reverb: pre-delay → four allpass diffusers a side → an 8-line feedback delay
 * network mixed by a (fast Walsh–) Hadamard matrix. Each line has a one-pole low-pass (damping) and
 * a gain that makes it lose 60 dB in Decay seconds for its own length (Jot), so the RT60 holds at
 * any Size. Every line drifts slowly in length against ringing. Left and right are two orthogonal
 * sums of the lines (decorrelated); the wet level is normalized by the tail's energy so Decay
 * changes the length, not the loudness. Cost doesn't depend on Decay; all buffers are sized at
 * construction for the largest Size and pre-delay.
 *
 * The audio is handled in chunks of at most CONTROL_FRAMES frames, stage by stage over the whole chunk
 * (`processChunk`), which keeps each stage's loop short and tight.
 */
export class ReverbKernel extends EffectKernel<Params> {
  // Delay lines: one buffer, LINE_COUNT lines of `lineSize` frames, one shared write position.
  private readonly lineSize = powerOfTwoAtLeast(
    Math.ceil(((LONGEST_LINE_MS + 2 * DRIFT_DEPTH_MS) / 1000) * this.sampleRate) + 8,
  );
  private readonly lineMask = this.lineSize - 1;
  private readonly lineBuffer = new Float32Array(LINE_COUNT * this.lineSize);
  private lineWritePosition = 0;
  // Pre-delay: two channels.
  private readonly preDelaySize = powerOfTwoAtLeast(Math.ceil(MAX_PRE_DELAY_SEC * this.sampleRate) + 4);
  private readonly preDelayMask = this.preDelaySize - 1;
  private readonly preDelayBuffer = new Float32Array(2 * this.preDelaySize);
  private preDelayWritePosition = 0;
  // Diffusers: 8 allpasses (4 a side), each a ring of exactly its length read and written at its position.
  private readonly diffuserRings = DIFFUSER_MS.map(
    (ms) => new Float32Array(Math.max(1, Math.round((ms / 1000) * this.sampleRate))),
  );
  private readonly diffuserPositions = new Int32Array(DIFFUSER_MS.length);
  // The lines' own allpasses, rings like the diffusers'.
  private readonly loopRings = LOOP_ALLPASS_MS.map(
    (ms) => new Float32Array(Math.max(1, Math.round((ms / 1000) * this.sampleRate))),
  );
  private readonly loopPositions = new Int32Array(LINE_COUNT);

  /** Current delay of each line (frames, fractional) and its per-frame step toward the next target. */
  private readonly lineDelay = new Float64Array(LINE_COUNT);
  private readonly delayStep = new Float64Array(LINE_COUNT);
  private readonly delayGoal = new Float64Array(LINE_COUNT);
  /** Each line's delay split for the allpass interpolation: whole frames and the allpass coefficient. */
  private readonly delayWhole = new Int32Array(LINE_COUNT);
  private readonly delayAllpassCoefficient = new Float64Array(LINE_COUNT);
  /** Length of each line without drift (frames), for the coefficients. */
  private readonly nominalDelay = new Float64Array(LINE_COUNT);
  /** Each line's feedback gain, the value it ramps to by the next control update, and its step. */
  private readonly lineGain = new Float64Array(LINE_COUNT);
  private readonly lineGainTarget = new Float64Array(LINE_COUNT);
  private readonly lineGainStep = new Float64Array(LINE_COUNT);
  /**
   * Each line's two first-order shelves (transposed direct form II, one state each): a low shelf
   * (lows decay slower) and a high shelf (Damping), as [low b0, low b1, high b0, high b1], and after
   * the lines the input's shelf (INPUT_SHELF_AT).
   */
  private readonly shelfCoefficients = new Float64Array(INPUT_SHELF_AT + 2);
  private readonly lowShelfState = new Float64Array(LINE_COUNT);
  private readonly highShelfState = new Float64Array(LINE_COUNT);
  /** The input's high shelf (the highs start quieter): its coefficients and its left/right states. */
  private inputShelfB0 = 1;
  private inputShelfB1 = 0;
  private readonly inputShelfState = new Float64Array(2);
  /** Each line's fractional-delay allpass state (its last output). */
  private readonly interpolatorState = new Float64Array(LINE_COUNT);
  /** Where each line is in its slow drift (0–1 of a cycle). */
  private readonly driftPhase = new Float64Array(LINE_COUNT);
  /** Bilinear-transform corner frequencies of the shelves, and their (shared) feedback coefficients. */
  private readonly lowShelfOmega = Math.tan((Math.PI * Math.min(LOW_BAND_HZ, 0.2 * this.sampleRate)) / this.sampleRate);
  private readonly highShelfOmega = Math.tan(
    (Math.PI * Math.min(HIGH_BAND_HZ, 0.4 * this.sampleRate)) / this.sampleRate,
  );
  private readonly lowShelfFeedback = (this.lowShelfOmega - 1) / (this.lowShelfOmega + 1);
  private readonly highShelfFeedback = (this.highShelfOmega - 1) / (this.highShelfOmega + 1);
  // Frequencies for the energy estimate: dense at the lows (ω = π·u², u evenly spaced), where the
  // longest-ringing part of the tail is, with the matching weights.
  private readonly energyCosines = Float64Array.from({ length: ENERGY_POINTS }, (_, k) =>
    Math.cos(Math.PI * ((k + 0.5) / ENERGY_POINTS) ** 2),
  );
  private readonly energyWeights = Float64Array.from(
    { length: ENERGY_POINTS },
    (_, k) => (2 * (k + 0.5)) / ENERGY_POINTS,
  );
  private readonly driftDepthFrames = (DRIFT_DEPTH_MS / 1000) * this.sampleRate;
  /** How far one control update moves a smoothed value towards its target (one-pole smoothing). */
  private readonly paramSmoothing = 1 - Math.exp(-CONTROL_FRAMES / (PARAM_SMOOTH_SEC * this.sampleRate));
  private readonly sizeSmoothing = 1 - Math.exp(-CONTROL_FRAMES / (SIZE_SMOOTH_SEC * this.sampleRate));
  private readonly idleGateFrames = Math.round(IDLE_GATE_SEC * this.sampleRate);

  /** Smoothed Decay (s), Damping and Size (0–1), and the values they glide to. */
  private decay = 2.2;
  private damping = 0.5;
  private size = 0.6;
  private decayTarget = 2.2;
  private dampingTarget = 0.5;
  private sizeTarget = 0.6;
  /** Coefficients need recomputing (a smoothed value is still moving). */
  private isSettling = true;
  /** The next block snaps to its params instead of gliding (first block, after a reset). */
  private shouldSnapToParams = true;
  /**
   * Level of the sound fed into the network (ramped like the gains): it sets the tail's energy, so a
   * Decay change alters the length of new tails, not the level of the one ringing.
   */
  private inputScale = 1;
  private inputScaleTarget = 1;
  private inputScaleStep = 0;
  /** Frames left until the next control update. */
  private countdown = 0;
  /** Mix → dry/wet gains (cached: recomputed only when the mix changes). */
  private cachedMix = -1;
  private dryGain = 1;
  private wetGain = 0;
  /** Frames of silence in and a finished tail out; at idleGateFrames the network is cleared and idles. */
  private quietFrames = 0;
  private isIdle = true;
  /** This block's input and wet peaks (|L| + |R|), for the idle gate. */
  private inputPeak = 0;
  private wetPeak = 0;
  /** Scratch for one chunk: what each side feeds the network, and each line's output. */
  private readonly sendLeft = new Float64Array(CONTROL_FRAMES);
  private readonly sendRight = new Float64Array(CONTROL_FRAMES);
  private readonly lineOutputs = new Float64Array(LINE_COUNT * CONTROL_FRAMES);

  override reset(): void {
    this.clearNetwork();
    this.driftPhase.fill(0);
    this.shouldSnapToParams = true;
    this.isIdle = true;
    this.quietFrames = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? input[0]) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? output[0]) as Float32Array;
    if (params.mix.length === 1) this.setMix(params.mix[0] as number);

    // Idle (nothing in the network): stay idle while silence comes in.
    if (this.isIdle) {
      if (peakLevel(inLeft, inRight, frameCount) < SILENT_LEVEL) {
        this.passDryThrough(inLeft, inRight, outLeft, outRight, frameCount, params);
        return;
      }
      this.isIdle = false;
      this.quietFrames = 0;
    }

    this.setTargets(params.decay[0] as number, params.damping[0] as number, params.size[0] as number);
    this.inputPeak = 0;
    this.wetPeak = 0;
    let done = 0;
    while (done < frameCount) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.controlUpdate();
      }
      const chunkLength = Math.min(frameCount - done, this.countdown);
      this.countdown -= chunkLength;
      this.processChunk(inLeft, inRight, outLeft, outRight, done, chunkLength, params);
      done += chunkLength;
    }
    this.flushFilterStates();
    this.goIdleWhenTailIsOver(frameCount);
  }

  /** With nothing in the network and silence coming in, the output is just the dry signal. */
  private passDryThrough(
    inLeft: Float32Array,
    inRight: Float32Array,
    outLeft: Float32Array,
    outRight: Float32Array,
    frameCount: number,
    params: ParamBlock<Params>,
  ): void {
    for (let i = 0; i < frameCount; i++) {
      if (params.mix.length > 1) this.setMix(params.mix[i] as number);
      outLeft[i] = this.dryGain * (inLeft[i] as number);
      outRight[i] = this.dryGain * (inRight[i] as number);
    }
  }

  /** Flushes denormals and NaN out of the filter states. */
  private flushFilterStates(): void {
    const inputShelfState = this.inputShelfState;
    for (let side = 0; side < 2; side++) inputShelfState[side] = flush(inputShelfState[side] as number);
    for (let line = 0; line < LINE_COUNT; line++) {
      this.lowShelfState[line] = flush(this.lowShelfState[line] as number);
      this.highShelfState[line] = flush(this.highShelfState[line] as number);
      this.interpolatorState[line] = flush(this.interpolatorState[line] as number);
    }
  }

  /** Silence in and a tail under −100 dBFS for a while: clears the network and idles. */
  private goIdleWhenTailIsOver(frameCount: number): void {
    if (this.inputPeak >= SILENT_LEVEL || this.wetPeak >= TAIL_FLOOR) {
      this.quietFrames = 0;
      return;
    }
    this.quietFrames += frameCount;
    if (this.quietFrames < this.idleGateFrames) return;
    this.clearNetwork();
    this.isIdle = true;
    // With nothing in the network, the next sound starts at the current settings (no glide).
    this.shouldSnapToParams = true;
  }

  /**
   * `count` frames (at most CONTROL_FRAMES, so fewer than the shortest line: every read in the chunk sees
   * frames written before it) from frame `from`, stage by stage over the whole chunk.
   *
   * The five stages are blocks of this one method, not methods of their own: measured, five calls per 32-frame
   * chunk cost about 4 % of this effect's CPU (each call reloads the stage's state from fields).
   */
  private processChunk(
    inLeft: Float32Array,
    inRight: Float32Array,
    outLeft: Float32Array,
    outRight: Float32Array,
    from: number,
    count: number,
    params: ParamBlock<Params>,
  ): void {
    const preDelaySec = params.preDelay;
    const mix = params.mix;
    const firstWrite = this.lineWritePosition + 1;
    // Plain locals for the numbers the sample loops use: an imported name costs a property lookup per use
    // when the code runs through the test runner's module wrappers (the speed tests do).
    const lineCount = LINE_COUNT;
    const lineStride = CONTROL_FRAMES;
    const loopAllpassGain = LOOP_ALLPASS_GAIN;
    const linearReadAboveStep = LINEAR_READ_ABOVE_STEP;
    // Stage 1: pre-delay (linear interpolation: smooth when automated) and the input's high shelf.
    {
      const sendLeft = this.sendLeft;
      const sendRight = this.sendRight;
      const buffer = this.preDelayBuffer;
      const mask = this.preDelayMask;
      const size = this.preDelaySize;
      const isPreDelayConstant = preDelaySec.length === 1;
      let delayFrames = this.preDelayFrames(preDelaySec[isPreDelayConstant ? 0 : from] as number);
      let writePosition = this.preDelayWritePosition;
      const shelfB0 = this.inputShelfB0;
      const shelfB1 = this.inputShelfB1;
      const shelfFeedback = this.highShelfFeedback;
      let stateLeft = this.inputShelfState[0] as number;
      let stateRight = this.inputShelfState[1] as number;
      let peak = this.inputPeak;
      for (let j = 0; j < count; j++) {
        const left = inLeft[from + j] as number;
        const right = inRight[from + j] as number;
        const level = Math.abs(left) + Math.abs(right);
        if (level > peak) peak = level;
        writePosition = (writePosition + 1) & mask;
        buffer[writePosition] = left;
        buffer[size + writePosition] = right;
        if (!isPreDelayConstant) delayFrames = this.preDelayFrames(preDelaySec[from + j] as number);
        // Read between two frames: the whole frames back, and the fraction towards the one before.
        const wholeFrames = delayFrames | 0;
        const fraction = delayFrames - wholeFrames;
        const nearer = (writePosition - wholeFrames) & mask;
        const farther = (writePosition - wholeFrames - 1) & mask;
        const nearLeft = buffer[nearer] as number;
        const nearRight = buffer[size + nearer] as number;
        const delayedLeft = nearLeft + ((buffer[farther] as number) - nearLeft) * fraction;
        const delayedRight = nearRight + ((buffer[size + farther] as number) - nearRight) * fraction;
        const shelvedLeft = shelfB0 * delayedLeft + stateLeft;
        stateLeft = shelfB1 * delayedLeft - shelfFeedback * shelvedLeft;
        const shelvedRight = shelfB0 * delayedRight + stateRight;
        stateRight = shelfB1 * delayedRight - shelfFeedback * shelvedRight;
        sendLeft[j] = shelvedLeft;
        sendRight[j] = shelvedRight;
      }
      this.preDelayWritePosition = writePosition;
      this.inputShelfState[0] = stateLeft;
      this.inputShelfState[1] = stateRight;
      this.inputPeak = peak;
    }
    // Stage 2: input diffusion, four allpasses a side: v = x − g·w, y = w + g·v (w: the delayed state).
    {
      for (let diffuser = 0; diffuser < DIFFUSER_MS.length; diffuser++) {
        const ring = this.diffuserRings[diffuser] as Float32Array;
        const ringLength = ring.length;
        const gain = DIFFUSER_GAINS[diffuser % DIFFUSERS_PER_SIDE] as number;
        const send = diffuser < DIFFUSERS_PER_SIDE ? this.sendLeft : this.sendRight;
        let position = this.diffuserPositions[diffuser] as number;
        for (let j = 0; j < count; j++) {
          const delayed = ring[position] as number;
          const v = (send[j] as number) - gain * delayed;
          ring[position] = v;
          send[j] = delayed + gain * v;
          if (++position === ringLength) position = 0;
        }
        this.diffuserPositions[diffuser] = position;
      }
    }
    // Stage 3: the level fed into the network.
    {
      const sendLeft = this.sendLeft;
      const sendRight = this.sendRight;
      let scale = this.inputScale;
      const scaleStep = this.inputScaleStep;
      for (let j = 0; j < count; j++) {
        scale += scaleStep;
        sendLeft[j] = (sendLeft[j] as number) * scale;
        sendRight[j] = (sendRight[j] as number) * scale;
      }
      this.inputScale = scale;
    }
    // Stage 4: each line: read `delay` frames back, two shelves (the decay bands), its own allpass, its
    // gain. Fractional delays are allpass-interpolated (flat: no highs lost however often the tail
    // goes round), except while a line glides fast after a Size change: the allpass's switching
    // whole part would chirp there, and linear interpolation's slight dulling lasts only as long as
    // the glide. `firstWrite` is where the chunk's first frame will be written in the line buffer.
    {
      const buffer = this.lineBuffer;
      const mask = this.lineMask;
      const outputs = this.lineOutputs;
      const lowFeedback = this.lowShelfFeedback;
      const highFeedback = this.highShelfFeedback;
      const coefficients = this.shelfCoefficients;
      for (let line = 0; line < lineCount; line++) {
        const lineOffset = line * this.lineSize;
        const outputOffset = line * lineStride;
        const step = this.delayStep[line] as number;
        const readsLinearly = step > linearReadAboveStep || step < -linearReadAboveStep;
        let delay = this.lineDelay[line] as number;
        let whole = this.delayWhole[line] as number;
        let allpassCoefficient = this.delayAllpassCoefficient[line] as number;
        let interpolated = this.interpolatorState[line] as number;
        let lowState = this.lowShelfState[line] as number;
        let highState = this.highShelfState[line] as number;
        let gain = this.lineGain[line] as number;
        const gainStep = this.lineGainStep[line] as number;
        const lowB0 = coefficients[COEFFICIENTS_PER_LINE * line] as number;
        const lowB1 = coefficients[COEFFICIENTS_PER_LINE * line + 1] as number;
        const highB0 = coefficients[COEFFICIENTS_PER_LINE * line + 2] as number;
        const highB1 = coefficients[COEFFICIENTS_PER_LINE * line + 3] as number;
        const loopRing = this.loopRings[line] as Float32Array;
        const loopLength = loopRing.length;
        let loopPosition = this.loopPositions[line] as number;
        for (let j = 0; j < count; j++) {
          const writeAt = firstWrite + j;
          if (step !== 0) {
            delay += step;
            whole = (delay - 0.5) | 0;
            const fraction = delay - whole;
            allpassCoefficient = (1 - fraction) / (1 + fraction);
          }
          if (readsLinearly) {
            const wholeFrames = delay | 0;
            const nearer = buffer[lineOffset + ((writeAt - wholeFrames) & mask)] as number;
            const farther = buffer[lineOffset + ((writeAt - wholeFrames - 1) & mask)] as number;
            interpolated = nearer + (farther - nearer) * (delay - wholeFrames);
          } else {
            const nearer = buffer[lineOffset + ((writeAt - whole) & mask)] as number;
            const farther = buffer[lineOffset + ((writeAt - whole - 1) & mask)] as number;
            interpolated = allpassCoefficient * (nearer - interpolated) + farther;
          }
          const lowShelved = lowB0 * interpolated + lowState;
          lowState = lowB1 * interpolated - lowFeedback * lowShelved;
          let shelved = highB0 * lowShelved + highState;
          highState = highB1 * lowShelved - highFeedback * shelved;
          // The loop allpass: v = x − g·w, y = w + g·v.
          const loopDelayed = loopRing[loopPosition] as number;
          shelved -= loopAllpassGain * loopDelayed;
          loopRing[loopPosition] = shelved;
          shelved = loopDelayed + loopAllpassGain * shelved;
          if (++loopPosition === loopLength) loopPosition = 0;
          gain += gainStep;
          outputs[outputOffset + j] = gain * shelved;
        }
        this.lineDelay[line] = delay;
        this.delayWhole[line] = whole;
        this.delayAllpassCoefficient[line] = allpassCoefficient;
        this.interpolatorState[line] = interpolated;
        this.lowShelfState[line] = lowState;
        this.highShelfState[line] = highState;
        this.lineGain[line] = gain;
        this.loopPositions[line] = loopPosition;
      }
    }
    // Stage 5: mix the lines with a fast Walsh–Hadamard transform (orthogonal after the 1/√8) and
    // write them back with the input: left into the even lines, right into the odd ones, negated in
    // lines 4–7 so the first echoes of a side don't all reach an output with the same sign (that would
    // boost the lows of every hit). Left and right are two orthogonal sums of the lines (decorrelated).
    // Also writes the output: the dry input plus the wet sums.
    {
      const buffer = this.lineBuffer;
      const mask = this.lineMask;
      const sendLeft = this.sendLeft;
      const sendRight = this.sendRight;
      const outputs = this.lineOutputs;
      const size = this.lineSize;
      const norm = 1 / Math.sqrt(8);
      const isMixConstant = mix.length === 1;
      let dry = this.dryGain;
      let wet = this.wetGain;
      let peak = this.wetPeak;
      for (let j = 0; j < count; j++) {
        const y0 = outputs[j] as number;
        const y1 = outputs[lineStride + j] as number;
        const y2 = outputs[2 * lineStride + j] as number;
        const y3 = outputs[3 * lineStride + j] as number;
        const y4 = outputs[4 * lineStride + j] as number;
        const y5 = outputs[5 * lineStride + j] as number;
        const y6 = outputs[6 * lineStride + j] as number;
        const y7 = outputs[7 * lineStride + j] as number;
        const wetLeft = y0 - y1 + y2 - y3 + y4 - y5 + y6 - y7;
        const wetRight = y0 + y1 - y2 - y3 + y4 + y5 - y6 - y7;
        // Walsh–Hadamard butterflies: pairs, then fours, then the eight.
        const t0 = y0 + y1;
        const t1 = y0 - y1;
        const t2 = y2 + y3;
        const t3 = y2 - y3;
        const t4 = y4 + y5;
        const t5 = y4 - y5;
        const t6 = y6 + y7;
        const t7 = y6 - y7;
        const u0 = t0 + t2;
        const u1 = t1 + t3;
        const u2 = t0 - t2;
        const u3 = t1 - t3;
        const u4 = t4 + t6;
        const u5 = t5 + t7;
        const u6 = t4 - t6;
        const u7 = t5 - t7;
        const left = sendLeft[j] as number;
        const right = sendRight[j] as number;
        const writeAt = (firstWrite + j) & mask;
        buffer[writeAt] = (u0 + u4) * norm + left;
        buffer[size + writeAt] = (u1 + u5) * norm + right;
        buffer[2 * size + writeAt] = (u2 + u6) * norm + left;
        buffer[3 * size + writeAt] = (u3 + u7) * norm + right;
        buffer[4 * size + writeAt] = (u0 - u4) * norm - left;
        buffer[5 * size + writeAt] = (u1 - u5) * norm - right;
        buffer[6 * size + writeAt] = (u2 - u6) * norm - left;
        buffer[7 * size + writeAt] = (u3 - u7) * norm - right;
        const wetLevel = Math.abs(wetLeft) + Math.abs(wetRight);
        if (wetLevel > peak) peak = wetLevel;
        if (!isMixConstant) {
          this.setMix(mix[from + j] as number);
          dry = this.dryGain;
          wet = this.wetGain;
        }
        outLeft[from + j] = dry * (inLeft[from + j] as number) + wet * wetLeft;
        outRight[from + j] = dry * (inRight[from + j] as number) + wet * wetRight;
      }
      this.wetPeak = peak;
    }
    this.lineWritePosition = (firstWrite + count - 1) & this.lineMask;
  }

  private clearNetwork(): void {
    this.lineBuffer.fill(0);
    this.preDelayBuffer.fill(0);
    for (const ring of this.diffuserRings) ring.fill(0);
    for (const ring of this.loopRings) ring.fill(0);
    this.lowShelfState.fill(0);
    this.highShelfState.fill(0);
    this.inputShelfState.fill(0);
    this.interpolatorState.fill(0);
  }

  /** The block's Decay, Damping and Size: glide there (or snap on the first block). */
  private setTargets(decay: number, damping: number, size: number): void {
    const decayClamped = Math.min(20, Math.max(0.05, decay));
    const dampingClamped = Math.min(1, Math.max(0, damping));
    const sizeClamped = Math.min(1, Math.max(0, size));
    if (decayClamped !== this.decayTarget || dampingClamped !== this.dampingTarget || sizeClamped !== this.sizeTarget) {
      this.decayTarget = decayClamped;
      this.dampingTarget = dampingClamped;
      this.sizeTarget = sizeClamped;
      this.isSettling = true;
    }
    if (this.shouldSnapToParams) {
      this.shouldSnapToParams = false;
      this.decay = decayClamped;
      this.damping = dampingClamped;
      this.size = sizeClamped;
      this.isSettling = true;
      this.controlUpdate();
      // Start every line at its length (no glide from the constructor's defaults).
      this.lineDelay.set(this.delayGoal);
      this.delayStep.fill(0);
      this.lineGain.set(this.lineGainTarget);
      this.lineGainStep.fill(0);
      this.inputScale = this.inputScaleTarget;
      this.inputScaleStep = 0;
      for (let line = 0; line < LINE_COUNT; line++) this.splitDelay(line);
      this.countdown = CONTROL_FRAMES;
    }
  }

  /** Control-rate update: smoothing, line lengths and drift, coefficients while settling. */
  private controlUpdate(): void {
    if (this.isSettling) this.smoothParams();
    // Gains and the input level ramp to their new values over the next CONTROL_FRAMES frames.
    for (let line = 0; line < LINE_COUNT; line++) {
      this.lineGainStep[line] =
        ((this.lineGainTarget[line] as number) - (this.lineGain[line] as number)) / CONTROL_FRAMES;
    }
    this.inputScaleStep = (this.inputScaleTarget - this.inputScale) / CONTROL_FRAMES;
    this.aimLineDelays();
  }

  /** Moves Decay, Damping and Size a step towards their targets and recomputes the coefficients from them. */
  private smoothParams(): void {
    this.decay += (this.decayTarget - this.decay) * this.paramSmoothing;
    this.damping += (this.dampingTarget - this.damping) * this.paramSmoothing;
    this.size += (this.sizeTarget - this.size) * this.sizeSmoothing;
    const isDone =
      Math.abs(this.decay - this.decayTarget) < 1e-4 * this.decayTarget &&
      Math.abs(this.damping - this.dampingTarget) < 1e-4 &&
      Math.abs(this.size - this.sizeTarget) < 1e-5;
    if (isDone) {
      this.decay = this.decayTarget;
      this.damping = this.dampingTarget;
      this.size = this.sizeTarget;
    }
    this.computeCoefficients();
    this.isSettling = !isDone;
  }

  /** Sets each line's delay goal (its length plus drift) and the per-frame step that reaches it by the next update. */
  private aimLineDelays(): void {
    const goal = this.delayGoal;
    const delay = this.lineDelay;
    const step = this.delayStep;
    // Reading a line before writing it adds a frame to its loop.
    for (let line = 0; line < LINE_COUNT; line++) goal[line] = (this.nominalDelay[line] as number) - 1;
    const updateSec = CONTROL_FRAMES / this.sampleRate;
    for (let line = 0; line < LINE_COUNT; line++) {
      const phase = (this.driftPhase[line] as number) + (DRIFT_RATES_HZ[line] as number) * updateSec;
      this.driftPhase[line] = phase >= 1 ? phase - 1 : phase;
      // Each line's drift starts at a different point of the cycle.
      goal[line] = (goal[line] as number) + this.driftDepthFrames * Math.sin(2 * Math.PI * (phase + line / LINE_COUNT));
    }
    for (let line = 0; line < LINE_COUNT; line++) {
      const target = goal[line] as number;
      const perFrame = (target - (delay[line] as number)) / CONTROL_FRAMES;
      if (Math.abs(perFrame) < 1e-9) {
        // Arrived: the line holds still (and skips its per-frame coefficient update).
        if (step[line] !== 0 || delay[line] !== target) {
          step[line] = 0;
          delay[line] = target;
          this.splitDelay(line);
        }
      } else step[line] = clampStep(perFrame);
    }
  }

  /** whole/coefficient for a line's current delay (lines that don't move keep theirs). */
  private splitDelay(line: number): void {
    const delay = this.lineDelay[line] as number;
    const whole = (delay - 0.5) | 0;
    const fraction = delay - whole;
    this.delayWhole[line] = whole;
    this.delayAllpassCoefficient[line] = (1 - fraction) / (1 + fraction);
  }

  /** Line lengths, per-line gains and shelves, and the input level for the smoothed params. */
  private computeCoefficients(): void {
    const sampleRate = this.sampleRate;
    const sizeScale = MIN_SIZE_SCALE + (1 - MIN_SIZE_SCALE) * this.size;
    const decaySec = this.decay;
    const lowDecaySec = decaySec * LOW_BAND_RATIO;
    const highDecaySec = decaySec * (1 - HIGH_BAND_DAMPING * this.damping);
    const highLevel = HIGH_BAND_LEVEL * (1 - 0.5 * this.damping);
    const shelves = this.shelfCoefficients;
    // The input shelf goes through the scratch slots past the lines' coefficients.
    shelfInto(shelves, INPUT_SHELF_AT, 1, highLevel, this.highShelfOmega);
    const inputB0 = shelves[INPUT_SHELF_AT] as number;
    const inputB1 = shelves[INPUT_SHELF_AT + 1] as number;
    this.inputShelfB0 = inputB0;
    this.inputShelfB1 = inputB1;
    let energy = 0;
    for (let line = 0; line < LINE_COUNT; line++) {
      this.nominalDelay[line] = ((LINE_MS[line] as number) / 1000) * sizeScale * sampleRate;
      // A round trip also goes through the line's allpass (its delay on average).
      const roundTripFrames = (this.nominalDelay[line] as number) + (this.loopRings[line] as Float32Array).length;
      // e^(−ln(1000)·len/(RT60·sr)) per round trip: 60 dB down after RT60 seconds.
      const gain = Math.exp((-LN_1000 * roundTripFrames) / (decaySec * sampleRate));
      this.lineGainTarget[line] = gain;
      const at = COEFFICIENTS_PER_LINE * line;
      const lowShelfDc = Math.exp((-LN_1000 * roundTripFrames) / (lowDecaySec * sampleRate)) / gain;
      shelfInto(shelves, at, lowShelfDc, 1, this.lowShelfOmega);
      const highShelfNyquist = Math.exp((-LN_1000 * roundTripFrames) / (highDecaySec * sampleRate)) / gain;
      shelfInto(shelves, at + 2, 1, highShelfNyquist, this.highShelfOmega);
      const lowB0 = shelves[at] as number;
      const lowB1 = shelves[at + 1] as number;
      const highB0 = shelves[at + 2] as number;
      const highB1 = shelves[at + 3] as number;
      // Energy that comes out of this line for a unit impulse into the reverb: Σ G^2k over the round trips.
      for (let point = 0; point < ENERGY_POINTS; point++) {
        const cosine = this.energyCosines[point] as number;
        const loopGainSquared =
          gain *
          gain *
          shelfPower(lowB0, lowB1, this.lowShelfFeedback, cosine) *
          shelfPower(highB0, highB1, this.highShelfFeedback, cosine);
        energy +=
          ((this.energyWeights[point] as number) *
            shelfPower(inputB0, inputB1, this.highShelfFeedback, cosine) *
            loopGainSquared) /
          (1 - loopGainSquared);
      }
    }
    // The output sums add 8 lines: their 1/√8 is folded in here.
    energy *= 8 / (LINE_COUNT * ENERGY_POINTS);
    // ×1.05: measured, the estimate leaves the tail about 0.4 dB short of unit energy.
    this.inputScaleTarget = energy > 0 ? 1.05 / Math.sqrt(energy) : 0;
  }

  private setMix(mix: number): void {
    if (mix === this.cachedMix) return;
    this.cachedMix = mix;
    this.dryGain = Math.cos(mix * HALF_PI);
    this.wetGain = Math.sin(mix * HALF_PI);
  }

  /** The pre-delay in frames, limited to what the buffer holds. */
  private preDelayFrames(seconds: number): number {
    const frames = seconds * this.sampleRate;
    const max = this.preDelaySize - 4;
    return frames > 0 ? (frames < max ? frames : max) : 0;
  }
}

/** The largest |left| + |right| over the first `count` frames. */
function peakLevel(left: Float32Array, right: Float32Array, count: number): number {
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const level = Math.abs(left[i] as number) + Math.abs(right[i] as number);
    if (level > peak) peak = level;
  }
  return peak;
}

/** Limits a per-frame delay step to ±MAX_GLIDE_STEP. */
function clampStep(step: number): number {
  return step > MAX_GLIDE_STEP ? MAX_GLIDE_STEP : step < -MAX_GLIDE_STEP ? -MAX_GLIDE_STEP : step;
}
