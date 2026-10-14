import { at, dbToGain, EffectKernel, EnvelopeFollower, Readings, type ParamBlock } from '@agstudio/sdk/worklet';
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
/** The band gains are worked out every STEP frames (from the peak since) and ramped in between. */
const STEP = 4;
/** Butterworth: two of these in series make a Linkwitz-Riley section. */
const K = Math.SQRT2;

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

/**
 * One band's compressor: a stereo-linked peak detector, the static curve and smoothing in dB,
 * evaluated every STEP frames on the peak of those frames (one logarithm and one exponential per
 * step), with the linear gain ramped across the step.
 */
class BandCompressor {
  readonly smooth: EnvelopeFollower;
  private attack = -1;
  private release = -1;
  private threshold = Number.NaN;
  /** Where the knee starts, as a linear level (below it nothing needs a logarithm). */
  private kneeStart = 0;
  private peak = 0;
  /** The gain this frame, and its change per frame until the next step. */
  gain = 1;
  private delta = 0;
  /** Gain reduction of the last step, dB. */
  reduction = 0;

  constructor(sampleRate: number) {
    this.smooth = new EnvelopeFollower(sampleRate / STEP, 10, 150);
  }

  /** Feeds a frame's peak level; returns the band's gain for it. */
  track(level: number): number {
    if (level > this.peak) this.peak = level;
    if (this.delta !== 0) this.gain += this.delta;
    return this.gain;
  }

  /** Every STEP frames: the next gain from the peak of the last ones. */
  step(threshold: number, ratio: number, attack: number, release: number, makeup: number): void {
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
    const peak = this.peak;
    this.peak = 0;
    const target = peak > this.kneeStart ? gainReduction(DB_PER_NEPER * Math.log(peak), threshold, ratio, KNEE) : 0;
    const gr = this.smooth.process(target);
    this.reduction = gr;
    const db = makeup - gr;
    const next = db === 0 ? 1 : Math.exp(NEPER_PER_DB * db);
    this.delta = (next - this.gain) / STEP;
    if (this.delta === 0) this.gain = next;
  }

  reset(): void {
    this.smooth.reset();
    this.reduction = 0;
    this.peak = 0;
    this.gain = 1;
    this.delta = 0;
  }
}

/**
 * Three-band compressor. Two Linkwitz-Riley crossovers split the signal (the low band goes
 * through the upper crossover's allpass so all three line up and sum flat), each band has its own
 * compressor, makeup gain, solo and bypass, and the bands are added back together. Untouched, the
 * output is the input through an allpass: the same level at every frequency.
 *
 * The crossovers are the SDK LinkwitzRiley's math (Cytomic state-variable filters) written out on
 * flat arrays: seven filter stages per side, cheap enough to leave the CPU to the compressors.
 */
export class MultibandKernel extends EffectKernel<P> {
  /** Coefficients (a1, a2, a3) of the low and the high crossover. */
  private readonly coef = new Float64Array(6);
  /**
   * Filter states (ic1, ic2) per side: [low xo: first, low stage, high stage; high xo: first, low
   * stage, high stage, allpass] = 7 stages × 2 values, left then right.
   */
  private readonly state = new Float64Array(28);
  private readonly cLow = new BandCompressor(this.sampleRate);
  private readonly cMid = new BandCompressor(this.sampleRate);
  private readonly cHigh = new BandCompressor(this.sampleRate);
  private readonly meter = new Readings(this.host, ['lowGr', 'midGr', 'highGr'] as const);
  private countdown = 0;
  private stepCount = 0;
  private lowHz = -1;
  private highHz = -1;
  private outDb = 0;
  private outGain = 1;

  override reset(): void {
    this.state.fill(0);
    this.cLow.reset();
    this.cMid.reset();
    this.cHigh.reset();
    this.countdown = 0;
    this.stepCount = 0;
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
    const c = this.coef;
    const s = this.state;
    let grLow = 0;
    let grMid = 0;
    let grHigh = 0;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.crossovers(at(p.lowFreq, i), at(p.highFreq, i));
        const out = at(p.output, i);
        if (out !== this.outDb) {
          this.outDb = out;
          this.outGain = dbToGain(out);
        }
      }
      this.countdown--;
      if (this.stepCount === 0) {
        if (!bypassLow)
          cLow.step(
            at(p.lowThreshold, i),
            at(p.lowRatio, i),
            at(p.lowAttack, i),
            at(p.lowRelease, i),
            at(p.lowGain, i),
          );
        if (!bypassMid)
          cMid.step(
            at(p.midThreshold, i),
            at(p.midRatio, i),
            at(p.midAttack, i),
            at(p.midRelease, i),
            at(p.midGain, i),
          );
        if (!bypassHigh)
          cHigh.step(
            at(p.highThreshold, i),
            at(p.highRatio, i),
            at(p.highAttack, i),
            at(p.highRelease, i),
            at(p.highGain, i),
          );
        if (!bypassLow && cLow.reduction > grLow) grLow = cLow.reduction;
        if (!bypassMid && cMid.reduction > grMid) grMid = cMid.reduction;
        if (!bypassHigh && cHigh.reduction > grHigh) grHigh = cHigh.reduction;
      }
      this.stepCount = this.stepCount + 1 < STEP ? this.stepCount + 1 : 0;
      const g = this.outGain;
      // Left, then right: split, compress, sum.
      for (let ch = 0; ch < 2; ch++) {
        const o = ch * 14;
        const x = (ch === 0 ? inL : inR)[i] as number;
        // Low crossover: the first stage's low and high outputs, then one more stage each.
        let a1 = c[0] as number;
        let a2 = c[1] as number;
        let a3 = c[2] as number;
        let ic1 = s[o] as number;
        let ic2 = s[o + 1] as number;
        let v3 = x - ic2;
        let v1 = a1 * ic1 + a2 * v3;
        let v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o] = 2 * v1 - ic1;
        s[o + 1] = 2 * v2 - ic2;
        const low1 = v2;
        const high1 = x - K * v1 - v2;
        ic1 = s[o + 2] as number;
        ic2 = s[o + 3] as number;
        v3 = low1 - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o + 2] = 2 * v1 - ic1;
        s[o + 3] = 2 * v2 - ic2;
        const lowBand = v2;
        ic1 = s[o + 4] as number;
        ic2 = s[o + 5] as number;
        v3 = high1 - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o + 4] = 2 * v1 - ic1;
        s[o + 5] = 2 * v2 - ic2;
        const rest = high1 - K * v1 - v2;
        // High crossover on the rest, and its allpass on the low band.
        a1 = c[3] as number;
        a2 = c[4] as number;
        a3 = c[5] as number;
        ic1 = s[o + 6] as number;
        ic2 = s[o + 7] as number;
        v3 = rest - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o + 6] = 2 * v1 - ic1;
        s[o + 7] = 2 * v2 - ic2;
        const low2 = v2;
        const high2 = rest - K * v1 - v2;
        ic1 = s[o + 8] as number;
        ic2 = s[o + 9] as number;
        v3 = low2 - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o + 8] = 2 * v1 - ic1;
        s[o + 9] = 2 * v2 - ic2;
        const mid = v2;
        ic1 = s[o + 10] as number;
        ic2 = s[o + 11] as number;
        v3 = high2 - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o + 10] = 2 * v1 - ic1;
        s[o + 11] = 2 * v2 - ic2;
        const high = high2 - K * v1 - v2;
        ic1 = s[o + 12] as number;
        ic2 = s[o + 13] as number;
        v3 = lowBand - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        s[o + 12] = 2 * v1 - ic1;
        s[o + 13] = 2 * v2 - ic2;
        const low = lowBand - 2 * K * v1;
        if (ch === 0) {
          this.bands[0] = low;
          this.bands[1] = mid;
          this.bands[2] = high;
        } else {
          this.bands[3] = low;
          this.bands[4] = mid;
          this.bands[5] = high;
        }
      }
      const b = this.bands;
      let g0 = bypassLow ? 1 : cLow.track(peak(b[0] as number, b[3] as number));
      let g1 = bypassMid ? 1 : cMid.track(peak(b[1] as number, b[4] as number));
      let g2 = bypassHigh ? 1 : cHigh.track(peak(b[2] as number, b[5] as number));
      if (anySolo) {
        if (!soloLow) g0 = 0;
        if (!soloMid) g1 = 0;
        if (!soloHigh) g2 = 0;
      }
      outL[i] = ((b[0] as number) * g0 + (b[1] as number) * g1 + (b[2] as number) * g2) * g;
      outR[i] = ((b[3] as number) * g0 + (b[4] as number) * g1 + (b[5] as number) * g2) * g;
    }
    // Silence must not leave denormals in the filters.
    for (let k = 0; k < s.length; k++) if (!(Math.abs(s[k] as number) > 1e-20)) s[k] = 0;
    const v = this.meter.values;
    v.lowGr = grLow;
    v.midGr = grMid;
    v.highGr = grHigh;
    this.meter.tick(n);
  }

  /** This frame's bands: low, mid, high (left), then the same for the right. */
  private readonly bands = new Float64Array(6);

  /** Crossover coefficients, recomputed when the frequencies move. */
  private crossovers(lowHz: number, highHz: number): void {
    // The high crossover stays at least an octave above the low one.
    const hi = Math.max(highHz, 2 * lowHz);
    if (lowHz === this.lowHz && hi === this.highHz) return;
    this.lowHz = lowHz;
    this.highHz = hi;
    design(this.coef, 0, lowHz, this.sampleRate);
    design(this.coef, 3, hi, this.sampleRate);
  }
}

/** Cytomic SVF coefficients (a1, a2, a3) at Butterworth Q for `freq`, into `out` at `o`. */
function design(out: Float64Array, o: number, freq: number, sampleRate: number): void {
  const g = Math.tan((Math.PI * Math.min(Math.max(freq, 1), sampleRate * 0.49)) / sampleRate);
  const a1 = 1 / (1 + g * (g + K));
  out[o] = a1;
  out[o + 1] = g * a1;
  out[o + 2] = g * g * a1;
}

function peak(a: number, b: number): number {
  const x = a < 0 ? -a : a;
  const y = b < 0 ? -b : b;
  return x > y ? x : y;
}
