import {
  at,
  DelayLine,
  EffectKernel,
  Lfo,
  OnePole,
  Svf,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { lofiLatencyFrames, type lofiParams } from './params';

type Params = typeof lofiParams;

/** Peak delay swing at 100 % wow / flutter, seconds (about ±30 and ±20 cents). */
const WOW_SEC = 0.005;
const FLUTTER_SEC = 0.0004;
const WOW_HZ = 0.55;
const FLUTTER_HZ = 7.3;
/** Modulation targets are computed every CONTROL frames and ramped in between. */
const CONTROL_FRAMES = 16;
/** Hiss level at 100 % (scales low-passed white noise to about −30 dBFS RMS). */
const HISS_LEVEL = 0.06;
const HISS_HZ = 5000;
/** Clicks per second at 100 % crackle. */
const CLICKS_PER_SECOND = 30;
const CLICK_LEVEL = 0.5;
/** Tone at its top (20 kHz) means "open": no filter. */
const TONE_OPEN = 20000;

/**
 * Lo-fi: wow and flutter (a delay line read at a slowly and quickly wobbling delay; its centre is
 * the reported latency, and the dry signal is read from the same centre so the mix lines up), then
 * sample-rate reduction (sample and hold), bit reduction (mid-tread, so silence stays silent), a
 * low-pass tone filter, and seeded hiss and vinyl crackle (exports repeat exactly).
 */
export class LofiKernel extends EffectKernel<Params> {
  readonly latency = lofiLatencyFrames(this.sampleRate);
  private readonly delayLines = [new DelayLine(2 * this.latency + 8), new DelayLine(2 * this.latency + 8)];
  private readonly wowDrift = new Lfo(this.sampleRate, 23);
  private readonly toneFilters = [new Svf(), new Svf()];
  private readonly hissFilters = [
    new OnePole().setCutoff(HISS_HZ, this.sampleRate),
    new OnePole().setCutoff(HISS_HZ, this.sampleRate),
  ];
  private readonly heldSamples = new Float64Array(2);
  private holdPhase = 1;
  private wobbleDelay = 0;
  private wobbleDelayStep = 0;
  private wobbleTime = 0;
  private countdown = 0;
  private toneHz = -1;
  private bitDepth = Number.NaN;
  private quantizeSteps = 1;
  /** The current click (a short decaying pulse, mono). */
  private clickLevel = 0;
  private isPrimed = false;

  constructor(host: KernelHost) {
    super(host);
    this.wowDrift.shape = 'smooth';
    this.wobbleDelay = this.latency;
  }

  override reset(): void {
    for (let channel = 0; channel < 2; channel++) {
      (this.delayLines[channel] as DelayLine).clear();
      (this.toneFilters[channel] as Svf).reset();
      (this.hissFilters[channel] as OnePole).reset();
    }
    this.heldSamples.fill(0);
    this.clickLevel = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const sampleRate = this.sampleRate;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.control(at(params.wow, i), at(params.flutter, i), at(params.tone, i));
      }
      this.countdown--;
      const delayFrames = this.wobbleDelay + this.wobbleDelayStep;
      this.wobbleDelay = delayFrames;
      const bitDepth = at(params.bits, i);
      if (bitDepth !== this.bitDepth) {
        this.bitDepth = bitDepth;
        this.quantizeSteps = Math.pow(2, bitDepth - 1);
      }
      const quantizeSteps = this.quantizeSteps;
      const reducedRateHz = at(params.rate, i);
      // Sample and hold at the reduced rate.
      this.holdPhase += reducedRateHz / sampleRate;
      const shouldHold = this.holdPhase >= 1;
      if (shouldHold) this.holdPhase -= Math.floor(this.holdPhase);
      const mix = at(params.mix, i);
      const hissLevel = at(params.noise, i) * HISS_LEVEL;
      const crackle = at(params.crackle, i);
      // Crackle: sparse random clicks, the same on both sides.
      if (crackle > 0 && this.host.rand() < (crackle * crackle * CLICKS_PER_SECOND) / sampleRate) {
        const sign = this.host.rand() < 0.5 ? -1 : 1;
        this.clickLevel += sign * (0.2 + 0.8 * this.host.rand()) * crackle * CLICK_LEVEL;
      }
      const clickNow = this.clickLevel;
      this.clickLevel = clickNow * 0.55;
      if (this.clickLevel > -1e-6 && this.clickLevel < 1e-6) this.clickLevel = 0;
      for (let channel = 0; channel < 2; channel++) {
        const inputSample = ((input[channel] ?? input[0]) as Float32Array)[i] as number;
        const delayLine = this.delayLines[channel] as DelayLine;
        delayLine.write(inputSample);
        const dry = delayLine.read(this.latency);
        const wobbled = delayLine.readCubic(delayFrames);
        if (shouldHold) this.heldSamples[channel] = wobbled;
        const crushed = Math.round((this.heldSamples[channel] as number) * quantizeSteps) / quantizeSteps;
        // The tone filter always runs (no cold start) but is left out when fully open.
        const toned = (this.toneFilters[channel] as Svf).process(crushed);
        let wet = this.toneHz >= TONE_OPEN ? crushed : toned;
        if (hissLevel > 0) wet += hissLevel * (this.hissFilters[channel] as OnePole).process(2 * this.host.rand() - 1);
        wet += clickNow;
        (output[channel] as Float32Array)[i] = dry + mix * (wet - dry);
      }
    }
  }

  /** New wobble target (ramped over CONTROL frames) and tone filter. */
  private control(wow: number, flutter: number, tone: number): void {
    const sampleRate = this.sampleRate;
    this.wobbleTime += CONTROL_FRAMES / sampleRate;
    const seconds = this.wobbleTime;
    const wowShape = 0.7 * Math.sin(2 * Math.PI * WOW_HZ * seconds) + 0.3 * this.wowDrift.atBeat(seconds, 1 / 0.31);
    const flutterShape =
      Math.sin(2 * Math.PI * FLUTTER_HZ * seconds) * 0.7 + Math.sin(2 * Math.PI * 1.53 * FLUTTER_HZ * seconds) * 0.3;
    const goalFrames = this.latency + (wow * WOW_SEC * wowShape + flutter * FLUTTER_SEC * flutterShape) * sampleRate;
    if (!this.isPrimed) {
      this.isPrimed = true;
      this.wobbleDelay = goalFrames;
    }
    this.wobbleDelayStep = (goalFrames - this.wobbleDelay) / CONTROL_FRAMES;
    if (tone !== this.toneHz) {
      this.toneHz = tone;
      for (let channel = 0; channel < 2; channel++)
        (this.toneFilters[channel] as Svf).set('lowpass', tone, Math.SQRT1_2, sampleRate);
    }
  }
}
