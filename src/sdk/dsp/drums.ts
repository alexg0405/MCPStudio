// Synthesized drum voices (808/909-style models). Allocation-free after construction; usable on any
// thread. Each model: set its public fields, `trigger(velocity)`, then call `next()` once per sample
// until `active` turns false. `choke()` fades a voice out in a few milliseconds (hi-hat groups).

import { polyBlep } from './polyblep';
import { Svf } from './svf';
import { Noise } from './noise';

/** Per-sample multiplier that falls by 60 dB over `seconds`. */
function t60(seconds: number, sampleRate: number): number {
  return Math.exp(-6.907755 / Math.max(1e-4, seconds * sampleRate));
}

/** tanh, rational approximation (within 0.025 of it, exactly ±1 from ±3 on), for drive stages. */
export function softClip(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

const LN2 = Math.LN2;
/** 2^0 … 2^7, for `pow2`. */
const POW2_INT = [1, 2, 4, 8, 16, 32, 64, 128] as const;

/**
 * 2^u for a pitch sweep (u = semitones / 12, falling towards 0). Inside 0 ≤ u < 8 it is 2^⌊u⌋ times
 * e^(x) for the fraction x = (u − ⌊u⌋)·ln 2, by a degree-9 Taylor series (relative error below 1e-8): a few
 * multiplies per sample, where Math.pow is a call. Outside that range it is Math.pow.
 */
export function pow2(u: number): number {
  if (!(u >= 0 && u < 8)) return Math.pow(2, u);
  const n = Math.floor(u);
  const x = (u - n) * LN2;
  const p =
    1 +
    x *
      (1 +
        x *
          (1 / 2 +
            x *
              (1 / 6 +
                x *
                  (1 / 24 +
                    x * (1 / 120 + x * (1 / 720 + x * (1 / 5040 + x * (1 / 40320 + x * (1 / 362880)))))))));
  return (POW2_INT[n] as number) * p;
}

/** Below this the voice is done (−80 dB). */
const SILENT = 1e-4;
const CHOKE_SECONDS = 0.005;

abstract class DrumVoice {
  active = false;
  protected vel = 1;
  /** Samples since the trigger. */
  protected n = 0;
  protected choking = false;
  protected chokeGain = 1;
  protected readonly chokeStep: number;

  constructor(readonly sampleRate: number) {
    this.chokeStep = 1 / (CHOKE_SECONDS * sampleRate);
  }

  trigger(velocity: number): void {
    this.vel = velocity;
    this.n = 0;
    this.choking = false;
    this.chokeGain = 1;
    this.active = true;
    this.start();
  }

  /** Fades the voice out over 5 ms (a closed hat cutting an open one). */
  choke(): void {
    if (this.active) this.choking = true;
  }

  reset(): void {
    this.active = false;
    this.choking = false;
  }

  next(): number {
    if (!this.active) return 0;
    let y = this.tick();
    this.n++;
    if (this.choking) {
      this.chokeGain -= this.chokeStep;
      if (this.chokeGain <= 0) {
        this.active = false;
        return 0;
      }
      y *= this.chokeGain;
    }
    return y;
  }

  protected abstract start(): void;
  /** One sample; sets `active = false` once it has died away. */
  protected abstract tick(): number;
}

/**
 * Kick: a sine whose pitch falls from `sweep` semitones above `pitch` (time constant `sweepTime`),
 * with a short noise `click` and a `drive` stage. `decay` is the time to fall by 60 dB.
 */
export class Kick extends DrumVoice {
  /** End pitch in Hz. */
  pitch = 50;
  /** Start pitch above `pitch`, in semitones. */
  sweep = 24;
  /** Time constant of the pitch fall, seconds. */
  sweepTime = 0.045;
  decay = 0.5;
  /** 0–1. */
  click = 0.3;
  /** 0–1. */
  drive = 0.2;
  private phase = 0;
  private amp = 0;
  private ampCoef = 1;
  private clickEnv = 0;
  private clickCoef = 1;
  private sweepCoef = 1;
  private sweepEnv = 1;
  private readonly noise: Noise;
  private readonly clickFilter = new Svf();

  constructor(sampleRate: number, seed = 1) {
    super(sampleRate);
    this.noise = new Noise(seed);
  }

  protected start(): void {
    const sr = this.sampleRate;
    this.phase = 0;
    this.amp = 1;
    this.ampCoef = t60(this.decay, sr);
    this.clickEnv = 1;
    this.clickCoef = Math.exp(-1 / (0.0012 * sr));
    this.sweepEnv = 1;
    this.sweepCoef = Math.exp(-1 / (Math.max(0.001, this.sweepTime) * sr));
    this.clickFilter.reset();
    this.clickFilter.set('bandpass', 3500, 0.8, sr);
  }

  protected tick(): number {
    const sr = this.sampleRate;
    const f = this.pitch * pow2((this.sweep / 12) * this.sweepEnv);
    this.sweepEnv *= this.sweepCoef;
    this.phase += f / sr;
    if (this.phase >= 1) this.phase -= 1;
    let y = Math.sin(2 * Math.PI * this.phase) * this.amp;
    this.amp *= this.ampCoef;
    if (this.click > 0 && this.clickEnv > SILENT) {
      y += this.click * 1.5 * this.clickEnv * this.clickFilter.process(this.noise.white());
      this.clickEnv *= this.clickCoef;
    }
    if (this.drive > 0) {
      const g = 1 + 6 * this.drive;
      y = softClip(y * g) / softClip(g);
    }
    if (this.amp < SILENT && this.clickEnv < SILENT) this.active = false;
    return y * this.vel;
  }
}

/**
 * Snare: two drum-head modes around `tone` Hz (pitch dropping slightly) plus noise through a
 * high-pass at `brightness` Hz. `snappy` (0–1) is the share of noise; `decay` the noise's 60 dB time.
 */
export class Snare extends DrumVoice {
  tone = 185;
  snappy = 0.6;
  decay = 0.2;
  brightness = 2500;
  private p1 = 0;
  private p2 = 0;
  private body = 0;
  private bodyCoef = 1;
  private nz = 0;
  private nzCoef = 1;
  private bend = 1;
  private bendCoef = 1;
  private readonly noise: Noise;
  private readonly hp = new Svf();
  private readonly peak = new Svf();

  constructor(sampleRate: number, seed = 2) {
    super(sampleRate);
    this.noise = new Noise(seed);
  }

  protected start(): void {
    const sr = this.sampleRate;
    this.p1 = 0;
    this.p2 = 0;
    this.body = 1;
    this.bodyCoef = t60(Math.min(0.25, 0.4 * this.decay + 0.04), sr);
    this.nz = 1;
    this.nzCoef = t60(this.decay, sr);
    this.bend = 1;
    this.bendCoef = Math.exp(-1 / (0.012 * sr));
    this.hp.reset();
    this.hp.set('highpass', this.brightness, 0.7, sr);
    this.peak.reset();
    this.peak.set('bell', this.brightness * 2, 1, sr, 6);
  }

  protected tick(): number {
    const sr = this.sampleRate;
    const f = this.tone * (1 + 0.35 * this.bend);
    this.bend *= this.bendCoef;
    this.p1 += f / sr;
    if (this.p1 >= 1) this.p1 -= 1;
    this.p2 += (f * 1.62) / sr;
    if (this.p2 >= 1) this.p2 -= 1;
    const head = (Math.sin(2 * Math.PI * this.p1) + 0.6 * Math.sin(2 * Math.PI * this.p2)) * this.body;
    this.body *= this.bodyCoef;
    const wires = this.peak.process(this.hp.process(this.noise.white())) * this.nz;
    this.nz *= this.nzCoef;
    if (this.body < SILENT && this.nz < SILENT) this.active = false;
    return (0.6 * (1 - 0.5 * this.snappy) * head + 0.4 * this.snappy * wires) * this.vel;
  }
}

/**
 * Clap: noise through a band-pass at `tone` Hz, in four quick bursts `spread` seconds apart and a
 * tail that falls by 60 dB over `decay`.
 */
export class Clap extends DrumVoice {
  tone = 1200;
  decay = 0.25;
  spread = 0.011;
  private tail = 0;
  private tailCoef = 1;
  private burstCoef = 1;
  private burst = 0;
  private readonly noise: Noise;
  private readonly bp = new Svf();

  constructor(sampleRate: number, seed = 3) {
    super(sampleRate);
    this.noise = new Noise(seed);
  }

  protected start(): void {
    const sr = this.sampleRate;
    this.tail = 0;
    this.tailCoef = t60(this.decay, sr);
    this.burstCoef = Math.exp(-1 / (0.0035 * sr));
    this.burst = 0;
    this.bp.reset();
    this.bp.set('bandpass', this.tone, 1.4, sr);
  }

  protected tick(): number {
    const gap = Math.max(1, Math.round(this.spread * this.sampleRate));
    const k = Math.floor(this.n / gap);
    if (this.n % gap === 0 && k < 4) {
      if (k < 3) this.burst = 1;
      else this.tail = 1;
    }
    const env = this.burst + this.tail;
    this.burst *= this.burstCoef;
    this.tail *= this.tailCoef;
    const y = this.bp.process(this.noise.white()) * env * 2.9;
    if (this.n > 4 * gap && this.tail < SILENT) this.active = false;
    return y * this.vel;
  }
}

/** The six square-wave frequencies of the TR-808's cymbal and hi-hat circuit, relative to the lowest. */
const METAL = [1, 1.4827, 1.8003, 2.546, 2.6303, 3.8968] as const;

/**
 * Hi-hats and cymbals: six detuned square waves (the 808's metallic ratios) mixed with `noise` (0–1),
 * through a band-pass and a high-pass set by `tone` (0–1, darker to brighter). Short `decay` for a
 * closed hat, long for an open hat or a crash.
 */
export class HiHat extends DrumVoice {
  /** Base frequency of the metal oscillators (the 808 uses ~205 Hz). */
  pitch = 205;
  tone = 0.6;
  decay = 0.06;
  noiseMix = 0.25;
  private readonly phases = new Float64Array(6);
  private env = 0;
  private coef = 1;
  private attack = 0;
  private readonly noise: Noise;
  private readonly bp = new Svf();
  private readonly hp = new Svf();

  constructor(sampleRate: number, seed = 4) {
    super(sampleRate);
    this.noise = new Noise(seed);
  }

  protected start(): void {
    const sr = this.sampleRate;
    for (let i = 0; i < 6; i++) this.phases[i] = (i * 0.37) % 1;
    this.env = 1;
    this.attack = 0;
    this.coef = t60(this.decay, sr);
    const centre = 5500 + 7000 * this.tone;
    this.bp.reset();
    this.bp.set('bandpass', Math.min(centre, sr * 0.45), 1.1, sr);
    this.hp.reset();
    this.hp.set('highpass', Math.min(3500 + 5000 * this.tone, sr * 0.45), 0.7, sr);
  }

  protected tick(): number {
    const sr = this.sampleRate;
    let metal = 0;
    for (let i = 0; i < 6; i++) {
      const dt = (this.pitch * (METAL[i] as number)) / sr;
      let t = (this.phases[i] as number) + dt;
      if (t >= 1) t -= 1;
      this.phases[i] = t;
      let sq = t < 0.5 ? 1 : -1;
      sq += polyBlep(t, dt);
      let t2 = t - 0.5;
      if (t2 < 0) t2 += 1;
      sq -= polyBlep(t2, dt);
      metal += sq;
    }
    const src = (1 - this.noiseMix) * metal * (1 / 6) + this.noiseMix * this.noise.white();
    // A 1 ms fade-in keeps the very first sample from clicking.
    if (this.attack < 1) this.attack = Math.min(1, this.attack + 1 / (0.001 * sr));
    const y = this.hp.process(this.bp.process(src)) * this.env * this.attack * 4.8;
    this.env *= this.coef;
    if (this.env < SILENT) this.active = false;
    return y * this.vel;
  }
}

/** Tom: a sine falling `sweep` semitones onto `pitch` Hz, with a little noise in the attack. */
export class Tom extends DrumVoice {
  pitch = 120;
  sweep = 7;
  decay = 0.4;
  private phase = 0;
  private amp = 0;
  private coef = 1;
  private bend = 1;
  private bendCoef = 1;
  private hit = 0;
  private hitCoef = 1;
  private readonly noise: Noise;
  private readonly lp = new Svf();

  constructor(sampleRate: number, seed = 5) {
    super(sampleRate);
    this.noise = new Noise(seed);
  }

  protected start(): void {
    const sr = this.sampleRate;
    this.phase = 0;
    this.amp = 1;
    this.coef = t60(this.decay, sr);
    this.bend = 1;
    this.bendCoef = Math.exp(-1 / (0.05 * sr));
    this.hit = 1;
    this.hitCoef = Math.exp(-1 / (0.004 * sr));
    this.lp.reset();
    this.lp.set('lowpass', Math.min(6000, sr * 0.45), 0.7, sr);
  }

  protected tick(): number {
    const sr = this.sampleRate;
    const f = this.pitch * pow2((this.sweep / 12) * this.bend);
    this.bend *= this.bendCoef;
    this.phase += f / sr;
    if (this.phase >= 1) this.phase -= 1;
    const y = Math.sin(2 * Math.PI * this.phase) * this.amp + 0.25 * this.hit * this.lp.process(this.noise.white());
    this.amp *= this.coef;
    this.hit *= this.hitCoef;
    if (this.amp < SILENT) this.active = false;
    return y * this.vel;
  }
}

/**
 * Tuned percussion (cowbell, rim, clave, wood block): two square waves at `pitch` and `pitch·ring`
 * through a band-pass, plus a `noise` click (0–1). `decay` is the 60 dB time.
 */
export class Perc extends DrumVoice {
  pitch = 560;
  ring = 1.48;
  decay = 0.15;
  noiseMix = 0.2;
  private p1 = 0;
  private p2 = 0;
  private env = 0;
  private coef = 1;
  private spike = 0;
  private spikeCoef = 1;
  private readonly noise: Noise;
  private readonly bp = new Svf();
  private readonly clickHp = new Svf();

  constructor(sampleRate: number, seed = 6) {
    super(sampleRate);
    this.noise = new Noise(seed);
  }

  protected start(): void {
    const sr = this.sampleRate;
    this.p1 = 0;
    this.p2 = 0;
    this.env = 1;
    this.coef = t60(this.decay, sr);
    this.spike = 1;
    this.spikeCoef = Math.exp(-1 / (0.004 * sr));
    this.bp.reset();
    this.bp.set('bandpass', Math.min(this.pitch * 1.6, sr * 0.45), 1.6, sr);
    this.clickHp.reset();
    this.clickHp.set('highpass', 2000, 0.7, sr);
  }

  protected tick(): number {
    const sr = this.sampleRate;
    const d1 = this.pitch / sr;
    const d2 = (this.pitch * this.ring) / sr;
    this.p1 += d1;
    if (this.p1 >= 1) this.p1 -= 1;
    this.p2 += d2;
    if (this.p2 >= 1) this.p2 -= 1;
    const sq1 = square(this.p1, d1);
    const sq2 = square(this.p2, d2);
    const tone = this.bp.process(sq1 + 0.8 * sq2) * this.env * (1 + 0.5 * this.spike);
    const click = this.noiseMix * this.spike * this.clickHp.process(this.noise.white());
    this.env *= this.coef;
    this.spike *= this.spikeCoef;
    if (this.env < SILENT) this.active = false;
    return (0.55 * tone + click) * this.vel;
  }
}

function square(t: number, dt: number): number {
  let sq = t < 0.5 ? 1 : -1;
  sq += polyBlep(t, dt);
  let t2 = t - 0.5;
  if (t2 < 0) t2 += 1;
  return sq - polyBlep(t2, dt);
}

/** Every drum model, for code that keeps one pool per kind. */
export type DrumModel = Kick | Snare | Clap | HiHat | Tom | Perc;

/**
 * Renders one hit of a drum voice into a new buffer (until it dies away or `maxSeconds`), e.g. to
 * build a sample kit at load time. The voice's fields are used as they are.
 */
export function renderDrum(voice: DrumModel, velocity = 1, maxSeconds = 3): Float32Array {
  const sr = voice.sampleRate;
  const max = Math.max(1, Math.round(maxSeconds * sr));
  const tmp = new Float32Array(max);
  voice.trigger(velocity);
  let n = 0;
  while (n < max && voice.active) tmp[n++] = voice.next();
  // A short fade-out if it was cut off by maxSeconds.
  if (voice.active) {
    const fade = Math.min(n, Math.round(0.01 * sr));
    for (let i = 0; i < fade; i++) tmp[n - fade + i] = (tmp[n - fade + i] as number) * (1 - (i + 1) / fade);
    voice.reset();
  }
  return tmp.slice(0, Math.max(1, n));
}
