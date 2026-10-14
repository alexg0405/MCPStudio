import {
  at,
  dbToGain,
  EffectKernel,
  EnvelopeFollower,
  LinkwitzRiley,
  Readings,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import type { multibandParams } from './params';

type P = typeof multibandParams;

/** Soft knee of every band, dB. */
const KNEE = 6;
/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;
/** ln(10) / 20: gain = exp(NEPER_PER_DB · dB). */
const NEPER_PER_DB = 0.11512925464970229;
/** Crossovers follow their params every CONTROL frames. */
const CONTROL = 32;

/**
 * Gain reduction in dB (≥ 0) of the static curve: hard above the threshold, a quadratic soft knee
 * `knee` dB wide around it (Giannoulis, Massberg & Reiss 2012).
 */
export function gainReduction(levelDb: number, threshold: number, ratio: number, knee: number): number {
  const over = levelDb - threshold;
  const slope = 1 - 1 / Math.max(1, ratio);
  if (knee > 0 && 2 * Math.abs(over) <= knee) {
    const x = over + knee / 2;
    return (slope * x * x) / (2 * knee);
  }
  return over > 0 ? slope * over : 0;
}

/** One band's compressor: a stereo-linked peak detector, the static curve, smoothing in dB. */
class BandCompressor {
  readonly smooth: EnvelopeFollower;
  private attack = -1;
  private release = -1;
  private threshold = Number.NaN;
  /** Where the knee starts, as a linear level (below it nothing needs a logarithm). */
  private kneeStart = 0;
  /** Gain reduction of the last frame, dB. */
  reduction = 0;

  constructor(sampleRate: number) {
    this.smooth = new EnvelopeFollower(sampleRate, 10, 150);
  }

  /** The band's gain for a frame whose peak is `level` (linear). */
  gain(level: number, threshold: number, ratio: number, attack: number, release: number, makeup: number): number {
    if (attack !== this.attack || release !== this.release) {
      this.attack = attack;
      this.release = release;
      this.smooth.setTimes(attack, release);
    }
    if (threshold !== this.threshold) {
      this.threshold = threshold;
      this.kneeStart = dbToGain(threshold - KNEE / 2);
    }
    // Under the knee there is nothing to compute (no logarithm).
    const target = level > this.kneeStart ? gainReduction(DB_PER_NEPER * Math.log(level), threshold, ratio, KNEE) : 0;
    const gr = this.smooth.process(target);
    this.reduction = gr;
    const db = makeup - gr;
    return db === 0 ? 1 : Math.exp(NEPER_PER_DB * db);
  }

  reset(): void {
    this.smooth.reset();
    this.reduction = 0;
  }
}

/**
 * Three-band compressor. Two Linkwitz-Riley crossovers split the signal (the low band goes
 * through the upper crossover's allpass so all three line up and sum flat), each band has its own
 * compressor, makeup gain, solo and bypass, and the bands are added back together. Untouched, the
 * output is the input through an allpass: the same level at every frequency.
 */
export class MultibandKernel extends EffectKernel<P> {
  private readonly lowL = new LinkwitzRiley();
  private readonly lowR = new LinkwitzRiley();
  private readonly highL = new LinkwitzRiley();
  private readonly highR = new LinkwitzRiley();
  private readonly cLow = new BandCompressor(this.sampleRate);
  private readonly cMid = new BandCompressor(this.sampleRate);
  private readonly cHigh = new BandCompressor(this.sampleRate);
  private readonly meter = new Readings(this.host, ['lowGr', 'midGr', 'highGr'] as const);
  private countdown = 0;
  private outDb = 0;
  private outGain = 1;

  override reset(): void {
    for (const x of [this.lowL, this.lowR, this.highL, this.highR]) x.reset();
    this.cLow.reset();
    this.cMid.reset();
    this.cHigh.reset();
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const soloLow = (p.lowSolo[0] as number) >= 0.5;
    const soloMid = (p.midSolo[0] as number) >= 0.5;
    const soloHigh = (p.highSolo[0] as number) >= 0.5;
    const anySolo = soloLow || soloMid || soloHigh;
    const bypassLow = (p.lowBypass[0] as number) >= 0.5;
    const bypassMid = (p.midBypass[0] as number) >= 0.5;
    const bypassHigh = (p.highBypass[0] as number) >= 0.5;
    const cLow = this.cLow;
    const cMid = this.cMid;
    const cHigh = this.cHigh;
    let grLow = 0;
    let grMid = 0;
    let grHigh = 0;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        const lo = at(p.lowFreq, i);
        // The high crossover stays at least an octave above the low one.
        const hi = Math.max(at(p.highFreq, i), 2 * lo);
        this.lowL.set(lo, this.sampleRate);
        this.lowR.set(lo, this.sampleRate);
        this.highL.set(hi, this.sampleRate);
        this.highR.set(hi, this.sampleRate);
        const out = at(p.output, i);
        if (out !== this.outDb) {
          this.outDb = out;
          this.outGain = dbToGain(out);
        }
      }
      this.countdown--;
      // Split.
      this.lowL.split(inL[i] as number);
      this.lowR.split(inR[i] as number);
      this.highL.split(this.lowL.high);
      this.highR.split(this.lowR.high);
      const l0 = this.highL.allpass(this.lowL.low);
      const r0 = this.highR.allpass(this.lowR.low);
      const l1 = this.highL.low;
      const r1 = this.highR.low;
      const l2 = this.highL.high;
      const r2 = this.highR.high;
      // Compress each band.
      let g0 = 1;
      let g1 = 1;
      let g2 = 1;
      if (!bypassLow) {
        g0 = cLow.gain(
          peak(l0, r0),
          at(p.lowThreshold, i),
          at(p.lowRatio, i),
          at(p.lowAttack, i),
          at(p.lowRelease, i),
          at(p.lowGain, i),
        );
        if (cLow.reduction > grLow) grLow = cLow.reduction;
      }
      if (!bypassMid) {
        g1 = cMid.gain(
          peak(l1, r1),
          at(p.midThreshold, i),
          at(p.midRatio, i),
          at(p.midAttack, i),
          at(p.midRelease, i),
          at(p.midGain, i),
        );
        if (cMid.reduction > grMid) grMid = cMid.reduction;
      }
      if (!bypassHigh) {
        g2 = cHigh.gain(
          peak(l2, r2),
          at(p.highThreshold, i),
          at(p.highRatio, i),
          at(p.highAttack, i),
          at(p.highRelease, i),
          at(p.highGain, i),
        );
        if (cHigh.reduction > grHigh) grHigh = cHigh.reduction;
      }
      if (anySolo) {
        if (!soloLow) g0 = 0;
        if (!soloMid) g1 = 0;
        if (!soloHigh) g2 = 0;
      }
      const g = this.outGain;
      outL[i] = (l0 * g0 + l1 * g1 + l2 * g2) * g;
      outR[i] = (r0 * g0 + r1 * g1 + r2 * g2) * g;
    }
    const v = this.meter.values;
    v.lowGr = grLow;
    v.midGr = grMid;
    v.highGr = grHigh;
    this.meter.tick(n);
  }
}

function peak(a: number, b: number): number {
  const x = a < 0 ? -a : a;
  const y = b < 0 ? -b : b;
  return x > y ? x : y;
}
