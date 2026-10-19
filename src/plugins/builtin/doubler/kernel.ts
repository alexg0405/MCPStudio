import { at, DelayLine, EffectKernel, OnePole, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import type { doublerParams } from './params';

type Params = typeof doublerParams;

const MAX_VOICES = 4;
/** Delay targets and gains are computed every CONTROL frames and ramped in between. */
const CONTROL_FRAMES = 32;
const TWO_PI = 2 * Math.PI;
/** 1200 / ln 2: cents = CENTS · ln(pitch ratio), and a pitch ratio is 1 − (change of delay per second). */
const CENTS_PER_LN_RATIO = 1731.2340490667561;
/** The timing of each voice against the Delay knob (spread 100 % uses these; 0 % puts every voice at 1). */
const VOICE_TIMING = [1, 1.45, 0.72, 1.9] as const;
/** Where each voice sits between left (−1) and right (+1) at 100 % width. */
const VOICE_PAN = [-1, 1, -0.6, 0.6] as const;
/** How fast each voice's pitch drifts, Hz: slow and unrelated, so the voices never move together. */
const DRIFT_HZ = [0.43, 0.57, 0.79, 1.03] as const;
/** A voice drifts with two sines: the second is this much faster and this share of the cents. */
const SECOND_SINE_SPEEDUP = 1.71;
const FIRST_SINE_SHARE = 0.65;
const SECOND_SINE_SHARE = 0.35;
/** Longest delay the line must hold: the Delay's maximum × the widest timing, plus the drift, in ms. */
const MAX_LINE_MS = 50 * 1.9 + 8;

/**
 * Doubler: two to four extra "takes" of a voice. The input is summed to mono, darkened, and read
 * back from one delay line by each voice at its own delay (timing spread) that wanders slowly (a
 * pair of sines per voice, scaled so the pitch error peaks at the Pitch drift in cents), then panned
 * between the sides with the Width. The original passes through untouched in the middle, so the sum
 * of left and right in mono is the voice plus a few quiet delayed copies (a comb of shallow notches
 * that the wandering delays smear), not a hollow sound.
 */
export class DoublerKernel extends EffectKernel<Params> {
  private readonly delayLine = new DelayLine(Math.ceil((MAX_LINE_MS * this.sampleRate) / 1000));
  private readonly toneFilter = new OnePole();
  /** Current delay (frames) and its change per frame, per voice. */
  private readonly voiceDelays = new Float64Array(MAX_VOICES);
  private readonly voiceDelaySteps = new Float64Array(MAX_VOICES);
  /** Current left and right gain of each voice and the change per frame. */
  private readonly gainLeft = new Float64Array(MAX_VOICES);
  private readonly gainRight = new Float64Array(MAX_VOICES);
  private readonly gainLeftStep = new Float64Array(MAX_VOICES);
  private readonly gainRightStep = new Float64Array(MAX_VOICES);
  /** Drift phases (0–1 cycles) of the two sines of each voice. */
  private readonly driftPhase1 = new Float64Array(MAX_VOICES);
  private readonly driftPhase2 = new Float64Array(MAX_VOICES);
  /** Voices whose delays are running (those above it start at their target, silent, and fade in). */
  private activeVoices = 0;
  private countdown = 0;
  private toneCutoffHz = -1;

  constructor(host: KernelHost) {
    super(host);
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      this.driftPhase1[voice] = this.host.rand();
      this.driftPhase2[voice] = this.host.rand();
    }
  }

  override reset(): void {
    this.delayLine.clear();
    this.toneFilter.reset();
    this.voiceDelays.fill(0);
    this.voiceDelaySteps.fill(0);
    this.gainLeft.fill(0);
    this.gainRight.fill(0);
    this.gainLeftStep.fill(0);
    this.gainRightStep.fill(0);
    this.activeVoices = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const voices = Math.max(2, Math.min(MAX_VOICES, Math.round(params.voices[0] as number)));
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.control(i, voices, params);
      }
      this.countdown--;
      const inputLeft = inLeft[i] as number;
      const inputRight = inRight[i] as number;
      this.delayLine.write(this.toneFilter.process(0.5 * (inputLeft + inputRight)));
      let wetLeft = 0;
      let wetRight = 0;
      for (let voice = 0; voice < this.activeVoices; voice++) {
        const delayFrames = (this.voiceDelays[voice] as number) + (this.voiceDelaySteps[voice] as number);
        this.voiceDelays[voice] = delayFrames;
        const voiceSample = this.delayLine.readCubic(delayFrames);
        const leftGain = (this.gainLeft[voice] as number) + (this.gainLeftStep[voice] as number);
        const rightGain = (this.gainRight[voice] as number) + (this.gainRightStep[voice] as number);
        this.gainLeft[voice] = leftGain;
        this.gainRight[voice] = rightGain;
        wetLeft += voiceSample * leftGain;
        wetRight += voiceSample * rightGain;
      }
      outLeft[i] = inputLeft + wetLeft;
      outRight[i] = inputRight + wetRight;
    }
  }

  /** The next delay and gain targets for every voice, reached by a straight line over CONTROL frames. */
  private control(frame: number, voices: number, p: ParamBlock<Params>): void {
    const sampleRate = this.sampleRate;
    const cutoffHz = at(p.tone, frame);
    if (cutoffHz !== this.toneCutoffHz) {
      this.toneCutoffHz = cutoffHz;
      this.toneFilter.setCutoff(cutoffHz, sampleRate);
    }
    const base = (at(p.delay, frame) * sampleRate) / 1000;
    const spread = at(p.spread, frame);
    const cents = at(p.drift, frame);
    const width = at(p.width, frame);
    const level = Math.pow(10, at(p.level, frame) / 20) / Math.sqrt(voices);
    let activeCount = 0;
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      const isOn = voice < voices;
      // The pitch error of a delay that moves is its speed: scale each sine so the two together peak at `cents`.
      const firstHz = DRIFT_HZ[voice] as number;
      const secondHz = firstHz * SECOND_SINE_SPEEDUP;
      const firstDepth = (cents * FIRST_SINE_SHARE * sampleRate) / (CENTS_PER_LN_RATIO * TWO_PI * firstHz);
      const secondDepth = (cents * SECOND_SINE_SHARE * sampleRate) / (CENTS_PER_LN_RATIO * TWO_PI * secondHz);
      const firstPhase = (this.driftPhase1[voice] as number) + (firstHz * CONTROL_FRAMES) / sampleRate;
      const secondPhase = (this.driftPhase2[voice] as number) + (secondHz * CONTROL_FRAMES) / sampleRate;
      this.driftPhase1[voice] = firstPhase - Math.floor(firstPhase);
      this.driftPhase2[voice] = secondPhase - Math.floor(secondPhase);
      const goal =
        base * (1 + spread * ((VOICE_TIMING[voice] as number) - 1)) +
        firstDepth * Math.sin(TWO_PI * (this.driftPhase1[voice] as number)) +
        secondDepth * Math.sin(TWO_PI * (this.driftPhase2[voice] as number));
      const angle = ((width * (VOICE_PAN[voice] as number) + 1) * Math.PI) / 4;
      const targetLeft = isOn ? level * Math.cos(angle) : 0;
      const targetRight = isOn ? level * Math.sin(angle) : 0;
      if (voice >= this.activeVoices) {
        // A voice that was off starts at its delay, silent, and fades in over this interval.
        this.voiceDelays[voice] = goal;
        this.gainLeft[voice] = 0;
        this.gainRight[voice] = 0;
      }
      this.voiceDelaySteps[voice] = (goal - (this.voiceDelays[voice] as number)) / CONTROL_FRAMES;
      this.gainLeftStep[voice] = (targetLeft - (this.gainLeft[voice] as number)) / CONTROL_FRAMES;
      this.gainRightStep[voice] = (targetRight - (this.gainRight[voice] as number)) / CONTROL_FRAMES;
      if (isOn || (this.gainLeft[voice] as number) > 1e-9 || (this.gainRight[voice] as number) > 1e-9)
        activeCount = voice + 1;
    }
    this.activeVoices = activeCount;
  }
}
