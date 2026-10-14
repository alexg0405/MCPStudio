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

type P = typeof lofiParams;

/** Peak delay swing at 100 % wow / flutter, seconds (about ±30 and ±20 cents). */
const WOW_SECONDS = 0.005;
const FLUTTER_SECONDS = 0.0004;
const WOW_HZ = 0.55;
const FLUTTER_HZ = 7.3;
/** Modulation targets are computed every CONTROL frames and ramped in between. */
const CONTROL = 16;
/** Hiss level at 100 % (scales low-passed white noise to about −30 dBFS RMS). */
const HISS = 0.06;
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
export class LofiKernel extends EffectKernel<P> {
  readonly latency = lofiLatencyFrames(this.sampleRate);
  private readonly lines = [new DelayLine(2 * this.latency + 8), new DelayLine(2 * this.latency + 8)];
  private readonly drift = new Lfo(this.sampleRate, 23);
  private readonly tones = [new Svf(), new Svf()];
  private readonly hissFilter = [
    new OnePole().setCutoff(HISS_HZ, this.sampleRate),
    new OnePole().setCutoff(HISS_HZ, this.sampleRate),
  ];
  private readonly held = new Float64Array(2);
  private holdPhase = 1;
  private delay = 0;
  private delayStep = 0;
  private time = 0;
  private countdown = 0;
  private toneHz = -1;
  private bits = Number.NaN;
  private steps = 1;
  /** The current click (a short decaying pulse, mono). */
  private click = 0;
  private primed = false;

  constructor(host: KernelHost) {
    super(host);
    this.drift.shape = 'smooth';
    this.delay = this.latency;
  }

  override reset(): void {
    for (let c = 0; c < 2; c++) {
      (this.lines[c] as DelayLine).clear();
      (this.tones[c] as Svf).reset();
      (this.hissFilter[c] as OnePole).reset();
    }
    this.held.fill(0);
    this.click = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const sr = this.sampleRate;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.control(at(p.wow, i), at(p.flutter, i), at(p.tone, i));
      }
      this.countdown--;
      const d = this.delay + this.delayStep;
      this.delay = d;
      const bits = at(p.bits, i);
      if (bits !== this.bits) {
        this.bits = bits;
        this.steps = Math.pow(2, bits - 1);
      }
      const steps = this.steps;
      const rate = at(p.rate, i);
      // Sample and hold at the reduced rate.
      this.holdPhase += rate / sr;
      const hold = this.holdPhase >= 1;
      if (hold) this.holdPhase -= Math.floor(this.holdPhase);
      const mix = at(p.mix, i);
      const hiss = at(p.noise, i) * HISS;
      const crackle = at(p.crackle, i);
      // Crackle: sparse random clicks, the same on both sides.
      if (crackle > 0 && this.host.rand() < (crackle * crackle * CLICKS_PER_SECOND) / sr) {
        const sign = this.host.rand() < 0.5 ? -1 : 1;
        this.click += sign * (0.2 + 0.8 * this.host.rand()) * crackle * CLICK_LEVEL;
      }
      const click = this.click;
      this.click = click * 0.55;
      if (this.click > -1e-6 && this.click < 1e-6) this.click = 0;
      for (let c = 0; c < 2; c++) {
        const x = ((input[c] ?? input[0]) as Float32Array)[i] as number;
        const line = this.lines[c] as DelayLine;
        line.write(x);
        const dry = line.read(this.latency);
        const wobbled = line.readCubic(d);
        if (hold) this.held[c] = wobbled;
        const crushed = Math.round((this.held[c] as number) * steps) / steps;
        // The tone filter always runs (no cold start) but is left out when fully open.
        const toned = (this.tones[c] as Svf).process(crushed);
        let wet = this.toneHz >= TONE_OPEN ? crushed : toned;
        if (hiss > 0) wet += hiss * (this.hissFilter[c] as OnePole).process(2 * this.host.rand() - 1);
        wet += click;
        (output[c] as Float32Array)[i] = dry + mix * (wet - dry);
      }
    }
  }

  /** New wobble target (ramped over CONTROL frames) and tone filter. */
  private control(wow: number, flutter: number, tone: number): void {
    const sr = this.sampleRate;
    this.time += CONTROL / sr;
    const t = this.time;
    const w = 0.7 * Math.sin(2 * Math.PI * WOW_HZ * t) + 0.3 * this.drift.atBeat(t, 1 / 0.31);
    const f = Math.sin(2 * Math.PI * FLUTTER_HZ * t) * 0.7 + Math.sin(2 * Math.PI * 1.53 * FLUTTER_HZ * t) * 0.3;
    const goal = this.latency + (wow * WOW_SECONDS * w + flutter * FLUTTER_SECONDS * f) * sr;
    if (!this.primed) {
      this.primed = true;
      this.delay = goal;
    }
    this.delayStep = (goal - this.delay) / CONTROL;
    if (tone !== this.toneHz) {
      this.toneHz = tone;
      for (let c = 0; c < 2; c++) (this.tones[c] as Svf).set('lowpass', tone, Math.SQRT1_2, sr);
    }
  }
}
