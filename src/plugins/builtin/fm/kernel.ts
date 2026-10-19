import {
  Adsr,
  at,
  dbToGain,
  FM_ALGORITHMS,
  FmOperator,
  InstrumentKernel,
  mtof,
  sinCycles,
  Svf,
  VoicePool,
  type KernelHost,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import { opParam, OPERATORS, type fmParams } from './params';

type Params = typeof fmParams;

/** Envelopes, pitch and levels update every CONTROL_FRAMES samples; levels glide linearly in between. */
const CONTROL_FRAMES = 16;
const VOICE_COUNT = 16;
/** A modulator at full level shifts the phase of what it feeds by up to 2π radians. */
const MOD_DEPTH = 2 * Math.PI;
/** The most frames rendered in one call (the mix buffers' size). */
const MAX_BLOCK_FRAMES = 4096;

/**
 * Per algorithm: which operator modulates which (4×4, [target][source]), which operators are heard (the carriers)
 * and the gain that keeps the sum of the carriers at one carrier's loudness.
 */
const ROUTES = FM_ALGORITHMS.map((algorithm) => {
  const modulation = new Float64Array(16);
  algorithm.modulators.forEach((sources, target) => sources.forEach((source) => (modulation[target * 4 + source] = 1)));
  const heard = new Float64Array(4);
  for (const carrier of algorithm.carriers) heard[carrier] = 1;
  return { m: modulation, heard, gain: 1 / Math.sqrt(algorithm.carriers.length) };
});

/**
 * The params a control step reads (ParamSnapshot.set takes them by index): the mod wheel and vibrato, then
 * per operator its ratio, fine tuning, level and velocity sensitivity.
 */
const SNAPSHOT_PARAMS: string[] = ['wheel', 'vibratoDepth', 'vibratoRate'];
for (let operator = 1; operator <= OPERATORS; operator++) {
  const paramIds = opParam(operator);
  SNAPSHOT_PARAMS.push(paramIds.ratio, paramIds.fine, paramIds.level, paramIds.velocity);
}

/**
 * The params a control step reads. Block-constant ones are set once per render call; automated
 * ones are re-set at each frame a control step reads them (FmKernel.control), so an automated block
 * costs a few sets per frame rather than the whole snapshot per voice.
 */
class ParamSnapshot {
  wheelMode = 0;
  vibratoDepth = 0;
  vibratoRate = 0;
  /** Per operator: frequency multiple (ratio, fine included), level and velocity sensitivity. */
  readonly frequencyMultiple = new Float64Array(4);
  readonly level = new Float64Array(4);
  readonly velocitySensitivity = new Float64Array(4);
  private readonly ratio = new Float64Array(4);
  private readonly fine = new Float64Array(4);

  /** Sets the param at position `slot` of SNAPSHOT_PARAMS to `value` (a plain value, as the param reads it). */
  set(slot: number, value: number): void {
    if (slot === 0) this.wheelMode = Math.round(value);
    else if (slot === 1) this.vibratoDepth = value;
    else if (slot === 2) this.vibratoRate = value;
    else {
      const operator = (slot - 3) >> 2;
      switch ((slot - 3) & 3) {
        case 0:
          this.ratio[operator] = Math.round(value);
          break;
        case 1:
          this.fine[operator] = value;
          break;
        case 2:
          this.level[operator] = value;
          return;
        default:
          this.velocitySensitivity[operator] = value;
          return;
      }
      const ratio = this.ratio[operator] as number;
      this.frequencyMultiple[operator] = (ratio === 0 ? 0.5 : ratio) * (1 + (this.fine[operator] as number));
    }
  }
}

/** One note: four operators with their envelopes and gliding levels, and the note's pan. */
class FmVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  /** Started but not yet set up (that happens at its first rendered frame, with that block's params). */
  needsSetUp = false;
  velocity = 1;
  fineCents = 0;
  gainLeft = Math.SQRT1_2;
  gainRight = Math.SQRT1_2;
  readonly op0 = new FmOperator();
  readonly op1 = new FmOperator();
  readonly op2 = new FmOperator();
  readonly op3 = new FmOperator();
  readonly envelopes: Adsr[];
  /** Current level of each operator, its per-sample step towards the next control target, and increments. */
  readonly levels = new Float64Array(4);
  readonly levelSteps = new Float64Array(4);
  readonly phaseIncrements = new Float64Array(4);
  countdown = 0;
  vibratoPhase = 0;
  /** The note's frequency in Hz. */
  frequencyHz = 440;

  constructor(controlRate: number) {
    this.envelopes = [new Adsr(controlRate), new Adsr(controlRate), new Adsr(controlRate), new Adsr(controlRate)];
  }
}

/**
 * Four-operator FM (phase modulation) synth: the eight classic 4-op algorithms, feedback on
 * operator 4, an ADSR and velocity sensitivity per operator, an optional low-pass "tone" filter,
 * vibrato and the mod wheel. 16 voices.
 */
export class FmKernel extends InstrumentKernel<Params> {
  private readonly pool: VoicePool<FmVoice>;
  private readonly operatorParamIds = Array.from({ length: OPERATORS }, (_, i) => opParam(i + 1));
  private modWheel = 0;
  private readonly mixLeft = new Float32Array(MAX_BLOCK_FRAMES);
  private readonly mixRight = new Float32Array(MAX_BLOCK_FRAMES);
  private readonly filterLeft = new Svf();
  private readonly filterRight = new Svf();
  private filterSetting = -1;
  private readonly cachedSampleRate: number;
  private readonly snapshot = new ParamSnapshot();
  /** This render call's arrays for SNAP_NAMES, and which of them are automated (per frame). */
  private readonly snapshotArrays: Float32Array[] = SNAPSHOT_PARAMS.map(() => new Float32Array(1));
  private readonly automatedSlots = new Int32Array(SNAPSHOT_PARAMS.length);
  private automatedCount = 0;
  /** The frame the automated params in the snapshot were last read at (-1: none yet this call). */
  private snapshotFrame = -1;

  constructor(host: KernelHost) {
    super(host);
    this.cachedSampleRate = host.sampleRate;
    const controlRate = host.sampleRate / CONTROL_FRAMES;
    this.pool = new VoicePool(VOICE_COUNT, () => new FmVoice(controlRate));
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    const voice = this.pool.start(noteId, key);
    voice.needsSetUp = true;
    voice.velocity = velocity;
    voice.fineCents = fine;
    const clampedPan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    voice.gainLeft = Math.sqrt(0.5 * (1 - clampedPan));
    voice.gainRight = Math.sqrt(0.5 * (1 + clampedPan));
    voice.countdown = 0;
  }

  noteOff(noteId: number, _key: number, _release: number): void {
    const voice = this.pool.find(noteId);
    if (!voice) return;
    // Released before it ever sounded: the note was cancelled.
    if (voice.needsSetUp) {
      this.silence(voice);
      return;
    }
    voice.releasing = true;
    for (let operator = 0; operator < 4; operator++) (voice.envelopes[operator] as Adsr).release();
  }

  override allNotesOff(hard: boolean): void {
    const voices = this.pool.voices;
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i] as FmVoice;
      if (!voice.active) continue;
      if (hard || voice.needsSetUp) this.silence(voice);
      else this.noteOff(voice.noteId, voice.key, 0.5);
    }
  }

  override controlChange(cc: number, value: number): void {
    if (cc === 1) this.modWheel = value;
  }

  override reset(): void {
    const voices = this.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) this.silence(voices[voiceIndex] as FmVoice);
    this.filterLeft.reset();
    this.filterRight.reset();
  }

  /** Frees a voice and clears its levels (the next note on it starts from silence). */
  private silence(voice: FmVoice): void {
    this.pool.free(voice);
    voice.needsSetUp = false;
    voice.levels.fill(0);
    voice.levelSteps.fill(0);
    for (let operator = 0; operator < 4; operator++) (voice.envelopes[operator] as Adsr).reset();
  }

  /**
   * Hands the snapshot the params a control step reads: block-constant ones are set now, automated ones (one value
   * per frame) are noted, to be set at each control step.
   */
  private bindSnapshot(params: ParamBlock<Params>): void {
    const boundArrays = this.snapshotArrays;
    let automatedCount = 0;
    for (let j = 0; j < SNAPSHOT_PARAMS.length; j++) {
      const values = params[SNAPSHOT_PARAMS[j] as string] as Float32Array;
      boundArrays[j] = values;
      if (values.length > 1) this.automatedSlots[automatedCount++] = j;
      else this.snapshot.set(j, values[0] as number);
    }
    this.automatedCount = automatedCount;
    this.snapshotFrame = -1;
  }

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<Params>): void {
    const frameCount = to - from;
    if (frameCount <= 0) return;
    this.bindSnapshot(params);
    const left = this.mixLeft;
    const right = this.mixRight;
    left.fill(0, 0, frameCount);
    right.fill(0, 0, frameCount);
    const route =
      ROUTES[Math.round(at(params.algorithm as Float32Array, from))] ?? (ROUTES[0] as (typeof ROUTES)[number]);
    const modulation = route.m;
    // Operator 4 (index 3) is never modulated by the others; 3 only by 4; 2 by 3 and 4; 1 by all.
    const op3IntoOp2 = (modulation[2 * 4 + 3] as number) * MOD_DEPTH;
    const op2IntoOp1 = (modulation[1 * 4 + 2] as number) * MOD_DEPTH;
    const op3IntoOp1 = (modulation[1 * 4 + 3] as number) * MOD_DEPTH;
    const op1IntoOp0 = (modulation[1] as number) * MOD_DEPTH;
    const op2IntoOp0 = (modulation[2] as number) * MOD_DEPTH;
    const op3IntoOp0 = (modulation[3] as number) * MOD_DEPTH;
    const heardGain0 = (route.heard[0] as number) * route.gain;
    const heardGain1 = (route.heard[1] as number) * route.gain;
    const heardGain2 = (route.heard[2] as number) * route.gain;
    const heardGain3 = (route.heard[3] as number) * route.gain;
    const feedback = at(params.feedback as Float32Array, from);
    let soundingVoices = 0;

    const voices = this.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as FmVoice;
      if (!voice.active) continue;
      soundingVoices++;
      const levels = voice.levels;
      const levelSteps = voice.levelSteps;
      const phaseIncrements = voice.phaseIncrements;
      for (let i = 0; i < frameCount; i++) {
        if (voice.countdown <= 0) {
          if (!this.control(voice, params, from + i, route.heard)) break;
          voice.countdown = CONTROL_FRAMES;
        }
        voice.countdown--;
        const level0 = (levels[0] = (levels[0] as number) + (levelSteps[0] as number));
        const level1 = (levels[1] = (levels[1] as number) + (levelSteps[1] as number));
        const level2 = (levels[2] = (levels[2] as number) + (levelSteps[2] as number));
        const level3 = (levels[3] = (levels[3] as number) + (levelSteps[3] as number));
        // An operator at level 0 (modulators 3 and 4 in a fresh patch) only advances its phase.
        const output3 =
          level3 !== 0
            ? voice.op3.feedback(phaseIncrements[3] as number, feedback, level3)
            : voice.op3.skip(phaseIncrements[3] as number);
        const output2 =
          level2 !== 0
            ? voice.op2.next(phaseIncrements[2] as number, op3IntoOp2 * output3, level2)
            : voice.op2.skip(phaseIncrements[2] as number);
        const output1 =
          level1 !== 0
            ? voice.op1.next(phaseIncrements[1] as number, op2IntoOp1 * output2 + op3IntoOp1 * output3, level1)
            : voice.op1.skip(phaseIncrements[1] as number);
        const output0 =
          level0 !== 0
            ? voice.op0.next(
                phaseIncrements[0] as number,
                op1IntoOp0 * output1 + op2IntoOp0 * output2 + op3IntoOp0 * output3,
                level0,
              )
            : voice.op0.skip(phaseIncrements[0] as number);
        const mixed = heardGain0 * output0 + heardGain1 * output1 + heardGain2 * output2 + heardGain3 * output3;
        left[i] = (left[i] as number) + mixed * voice.gainLeft;
        right[i] = (right[i] as number) + mixed * voice.gainRight;
      }
    }
    if (soundingVoices === 0 && this.filterSetting < 0) return;

    this.addToOutput(out, from, frameCount, params);
  }

  /** The tone filter (off at the top of its range), then the volume: adds the mix of the voices into `out`. */
  private addToOutput(out: Float32Array[], from: number, frameCount: number, params: ParamBlock<Params>): void {
    const left = this.mixLeft;
    const right = this.mixRight;
    const cutoffHz = at(params.cutoff as Float32Array, from);
    const isFiltered = cutoffHz < 19900;
    if (isFiltered) {
      const resonance = at(params.resonance as Float32Array, from);
      const filterSetting = cutoffHz * 10 + resonance;
      if (filterSetting !== this.filterSetting) {
        const qFactor = 0.707 * Math.pow(16, resonance);
        this.filterLeft.set('lowpass', cutoffHz, qFactor, this.sampleRate);
        this.filterRight.set('lowpass', cutoffHz, qFactor, this.sampleRate);
        this.filterSetting = filterSetting;
      }
    } else if (this.filterSetting >= 0) {
      this.filterSetting = -1;
      this.filterLeft.reset();
      this.filterRight.reset();
    }
    const masterGain = dbToGain(at(params.level as Float32Array, from)) * 0.5;
    const outLeft = out[0] as Float32Array;
    const outRight = (out[1] ?? out[0]) as Float32Array;
    for (let i = 0; i < frameCount; i++) {
      let leftSample = left[i] as number;
      let rightSample = right[i] as number;
      if (isFiltered) {
        leftSample = this.filterLeft.process(leftSample);
        rightSample = this.filterRight.process(rightSample);
      }
      outLeft[from + i] = (outLeft[from + i] as number) + leftSample * masterGain;
      outRight[from + i] = (outRight[from + i] as number) + rightSample * masterGain;
    }
  }

  /**
   * Sets up a new voice and computes the next control step: envelope levels, operator levels
   * (gliding there over CONTROL samples) and frequencies. Returns false once the voice has ended.
   */
  private control(voice: FmVoice, params: ParamBlock<Params>, frame: number, heard: Float64Array): boolean {
    const ids = this.operatorParamIds;
    if (voice.needsSetUp) {
      voice.needsSetUp = false;
      voice.frequencyHz = mtof(voice.key);
      // A voice taken from a sounding note keeps its levels and phases (no click) and its
      // envelopes start again from where they are.
      const isTakenOver =
        voice.levels[0] !== 0 || voice.levels[1] !== 0 || voice.levels[2] !== 0 || voice.levels[3] !== 0;
      for (let operator = 0; operator < 4; operator++) {
        const paramIds = ids[operator] as ReturnType<typeof opParam>;
        const envelope = voice.envelopes[operator] as Adsr;
        if (!isTakenOver) envelope.reset();
        envelope.set(
          at(params[paramIds.attack] as Float32Array, frame),
          at(params[paramIds.decay] as Float32Array, frame),
          at(params[paramIds.sustain] as Float32Array, frame),
          at(params[paramIds.release] as Float32Array, frame),
        );
        envelope.start();
      }
      if (!isTakenOver) {
        // Yamaha-style: every note starts its operators at phase 0, so attacks are consistent.
        voice.op0.reset();
        voice.op1.reset();
        voice.op2.reset();
        voice.op3.reset();
        voice.vibratoPhase = 0;
      }
    }
    // Done when every operator you hear has faded out.
    let isAlive = false;
    for (let o = 0; o < 4; o++) if ((heard[o] as number) > 0 && (voice.envelopes[o] as Adsr).active) isAlive = true;
    if (!isAlive) {
      this.silence(voice);
      return false;
    }

    // Automated params at this frame (shared by the voices that control at it).
    const settings = this.snapshot;
    if (this.snapshotFrame !== frame) {
      const bound = this.snapshotArrays;
      for (let k = 0; k < this.automatedCount; k++) {
        const j = this.automatedSlots[k] as number;
        settings.set(j, at(bound[j] as Float32Array, frame));
      }
      this.snapshotFrame = frame;
    }
    const wheelMode = settings.wheelMode;
    const brightness = wheelMode === 0 ? 1 + this.modWheel : 1;
    const vibratoDepthCents = settings.vibratoDepth + (wheelMode === 1 ? 50 * this.modWheel : 0);
    let pitchCents = at(this.pitch, frame) + voice.fineCents;
    if (vibratoDepthCents > 0) {
      voice.vibratoPhase += (settings.vibratoRate * CONTROL_FRAMES) / this.cachedSampleRate;
      if (voice.vibratoPhase >= 1) voice.vibratoPhase -= 1;
      pitchCents += vibratoDepthCents * sinCycles(voice.vibratoPhase);
    }
    // The note's frequency is fixed (set up with the voice); a pitch bend or vibrato scales it.
    const baseIncrement =
      (pitchCents === 0 ? voice.frequencyHz : voice.frequencyHz * Math.pow(2, pitchCents / 1200)) /
      this.cachedSampleRate;
    for (let o = 0; o < 4; o++) {
      // Keep every operator below Nyquist (a 16× ratio on a high note would alias).
      voice.phaseIncrements[o] = Math.min(0.45, baseIncrement * (settings.frequencyMultiple[o] as number));
      const level = settings.level[o] as number;
      const sensitivity = settings.velocitySensitivity[o] as number;
      const envelopeLevel = (voice.envelopes[o] as Adsr).next();
      let target = level * level * envelopeLevel * (1 - sensitivity + sensitivity * voice.velocity);
      if ((heard[o] as number) === 0) target *= brightness;
      voice.levelSteps[o] = (target - (voice.levels[o] as number)) / CONTROL_FRAMES;
    }
    return true;
  }
}
