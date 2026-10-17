import { at, dbToGain, EffectKernel, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import { BAND_COUNTS, type vocoderParams } from './params';

type P = typeof vocoderParams;

const MAX_BANDS = 32;
/** Centre of the lowest and highest band. */
const LOW_HZ = 90;
const HIGH_HZ = 9000;
/** The modulator's highs above this pass straight through (sibilance). */
const SIBILANCE_HZ = 6000;
/** Noise added to the carrier at 100 %. */
const NOISE_LEVEL = 0.15;
/** Brings the band products back to about the level of the input. */
const MAKEUP = 60;
/** Designs follow their params every CONTROL frames. */
const CONTROL = 32;
const COUNTS = BAND_COUNTS.map(Number);

/**
 * Channel vocoder. The modulator (a voice: the sidechain, mono) and the carrier (a synth: the
 * input, stereo) go through the same bank of 16–32 log-spaced band-passes (two state-variable
 * stages each, so neighbours overlap at −3 dB); an envelope follower on each modulator band sets
 * the level of the matching carrier band, and the bands are summed. Formant shifts the carrier
 * bands against the modulator's, Sibilance adds the voice's own highs, Noise helps whispers through.
 *
 * The bands are independent, so each control chunk (CONTROL frames, over which the designs and the
 * ballistics stay fixed) runs band by band: a band's coefficients and filter states stay in local
 * variables for the whole chunk, and the summed outputs are accumulated per frame. The arithmetic
 * is that of a frame-by-frame pass, operation for operation.
 */
export class VocoderKernel extends EffectKernel<P> {
  // Per band: modulator and carrier coefficients (a1, a2, 2g, k of a Cytomic SVF band-pass).
  private readonly mod = new Float64Array(4 * MAX_BANDS);
  private readonly car = new Float64Array(4 * MAX_BANDS);
  // Per band: two stages × (ic1, ic2) for the modulator and each carrier side.
  private readonly modState = new Float64Array(4 * MAX_BANDS);
  private readonly leftState = new Float64Array(4 * MAX_BANDS);
  private readonly rightState = new Float64Array(4 * MAX_BANDS);
  private readonly env = new Float64Array(MAX_BANDS);
  // The designs' cached parts: each band's centre frequency, and tan(πf/sr) of the modulator and carrier bands.
  private readonly bandHz = new Float64Array(MAX_BANDS);
  private readonly modG = new Float64Array(MAX_BANDS);
  private readonly carG = new Float64Array(MAX_BANDS);
  private spacing = 0;
  private readonly sibilance = new Svf().set('highpass', SIBILANCE_HZ, Math.SQRT1_2, this.sampleRate);
  // Per frame of the current control chunk: the modulator, the two carriers, the sibilance, and the
  // summed band outputs.
  private readonly mBuf = new Float64Array(CONTROL);
  private readonly clBuf = new Float64Array(CONTROL);
  private readonly crBuf = new Float64Array(CONTROL);
  private readonly sibBuf = new Float64Array(CONTROL);
  private readonly accL = new Float64Array(CONTROL);
  private readonly accR = new Float64Array(CONTROL);
  private count = 0;
  private width = -1;
  private formant = Number.NaN;
  private attack = -1;
  private release = -1;
  private attackCoef = 1;
  private releaseCoef = 1;
  private countdown = 0;
  private outDb = 0;
  private outGain = 1;

  override reset(): void {
    this.modState.fill(0);
    this.leftState.fill(0);
    this.rightState.fill(0);
    this.env.fill(0);
    this.sibilance.reset();
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    n: number,
    p: ParamBlock<P>,
    sidechain?: Float32Array[],
  ): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const key = sidechain ?? input;
    const kL = key[0] as Float32Array;
    const kR = (key[1] ?? kL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const count = COUNTS[Math.round(p.bands[0] as number)] ?? 24;
    // Fewer bands sum quieter: keep the level about the same whatever the count.
    const makeup = MAKEUP * Math.sqrt(24 / count);
    const mBuf = this.mBuf;
    const clBuf = this.clBuf;
    const crBuf = this.crBuf;
    const sibBuf = this.sibBuf;
    const accL = this.accL;
    const accR = this.accR;
    for (let i0 = 0; i0 < n;) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.design(count, at(p.width, i0), at(p.formant, i0));
        this.ballistics(at(p.attack, i0), at(p.release, i0));
        const out = at(p.output, i0);
        if (out !== this.outDb) {
          this.outDb = out;
          this.outGain = dbToGain(out);
        }
      }
      // The designs hold for the rest of the chunk (the countdown), so the chunk is that many frames.
      const len = Math.min(this.countdown, n - i0);
      this.countdown -= len;
      for (let j = 0; j < len; j++) {
        const i = i0 + j;
        const m = 0.5 * ((kL[i] as number) + (kR[i] as number));
        const noise = at(p.noise, i) * NOISE_LEVEL * (2 * this.host.rand() - 1);
        const xl = inL[i] as number;
        const xr = inR[i] as number;
        mBuf[j] = m;
        clBuf[j] = xl + noise;
        crBuf[j] = xr + noise;
        sibBuf[j] = at(p.sibilance, i) * this.sibilance.process(m);
        accL[j] = 0;
        accR[j] = 0;
      }
      const ac = this.attackCoef;
      const rc = this.releaseCoef;
      for (let b = 0; b < count; b++) this.band(b, len, ac, rc);
      const gain = this.outGain;
      for (let j = 0; j < len; j++) {
        const i = i0 + j;
        const xl = inL[i] as number;
        const xr = inR[i] as number;
        const mix = at(p.mix, i);
        const sib = sibBuf[j] as number;
        outL[i] = gain * (xl + mix * ((accL[j] as number) * makeup + sib - xl));
        outR[i] = gain * (xr + mix * ((accR[j] as number) * makeup + sib - xr));
      }
      i0 += len;
    }
    this.flushStates(count);
  }

  /**
   * One band over the frames of the current chunk: its modulator envelope, and its contribution to
   * the left and right carrier sums (`accL`, `accR`, per frame).
   */
  private band(b: number, len: number, ac: number, rc: number): void {
    const o = 4 * b;
    const mod = this.mod;
    const car = this.car;
    const mBuf = this.mBuf;
    const clBuf = this.clBuf;
    const crBuf = this.crBuf;
    const accL = this.accL;
    const accR = this.accR;
    const ma1 = mod[o] as number;
    const ma2 = mod[o + 1] as number;
    const mg2 = mod[o + 2] as number;
    const mk = mod[o + 3] as number;
    const a1 = car[o] as number;
    const a2 = car[o + 1] as number;
    const g2 = car[o + 2] as number;
    const k = car[o + 3] as number;
    // Stage 1 (ic1, ic2) and stage 2 (ic1, ic2) of each bank.
    const ms = this.modState;
    const ls = this.leftState;
    const rs = this.rightState;
    let mA = ms[o] as number;
    let mB = ms[o + 1] as number;
    let mC = ms[o + 2] as number;
    let mD = ms[o + 3] as number;
    let lA = ls[o] as number;
    let lB = ls[o + 1] as number;
    let lC = ls[o + 2] as number;
    let lD = ls[o + 3] as number;
    let rA = rs[o] as number;
    let rB = rs[o + 1] as number;
    let rC = rs[o + 2] as number;
    let rD = rs[o + 3] as number;
    let e = this.env[b] as number;
    // Each stage (trapezoidal SVF, g = tan(πf/sr)): v3 = x − ic2, v1 = a1·ic1 + a2·v3, output k·v1,
    // then ic1 = 2·v1 − ic1 and ic2 = ic2 + 2g·v1 (the same as 2·(ic2 + g·v1) − ic2).
    for (let j = 0; j < len; j++) {
      // Modulator band: two SVF band-pass stages.
      let v3 = (mBuf[j] as number) - mB;
      let v1 = ma1 * mA + ma2 * v3;
      const nA = 2 * v1 - mA;
      mB += mg2 * v1;
      mA = nA;
      let y = mk * v1;
      v3 = y - mD;
      v1 = ma1 * mC + ma2 * v3;
      const nC = 2 * v1 - mC;
      mD += mg2 * v1;
      mC = nC;
      y = mk * v1;
      // Its envelope.
      const level = y < 0 ? -y : y;
      const g = e + (level > e ? ac : rc) * (level - e);
      e = g;
      // Carrier band, left.
      v3 = (clBuf[j] as number) - lB;
      v1 = a1 * lA + a2 * v3;
      const lnA = 2 * v1 - lA;
      lB += g2 * v1;
      lA = lnA;
      y = k * v1;
      v3 = y - lD;
      v1 = a1 * lC + a2 * v3;
      const lnC = 2 * v1 - lC;
      lD += g2 * v1;
      lC = lnC;
      accL[j] = (accL[j] as number) + k * v1 * g;
      // Carrier band, right.
      v3 = (crBuf[j] as number) - rB;
      v1 = a1 * rA + a2 * v3;
      const rnA = 2 * v1 - rA;
      rB += g2 * v1;
      rA = rnA;
      y = k * v1;
      v3 = y - rD;
      v1 = a1 * rC + a2 * v3;
      const rnC = 2 * v1 - rC;
      rD += g2 * v1;
      rC = rnC;
      accR[j] = (accR[j] as number) + k * v1 * g;
    }
    ms[o] = mA;
    ms[o + 1] = mB;
    ms[o + 2] = mC;
    ms[o + 3] = mD;
    ls[o] = lA;
    ls[o + 1] = lB;
    ls[o + 2] = lC;
    ls[o + 3] = lD;
    rs[o] = rA;
    rs[o + 1] = rB;
    rs[o + 2] = rC;
    rs[o + 3] = rD;
    this.env[b] = e;
  }

  /**
   * Band frequencies and widths for both banks (only when they change). A band's frequency depends
   * on the band count, its carrier frequency also on the formant, and the filter's g only on the
   * frequency: those are kept, so a width change only redoes the Q-dependent part.
   */
  private design(count: number, width: number, formant: number): void {
    if (count === this.count && width === this.width && formant === this.formant) return;
    const sr = this.sampleRate;
    const countChanged = count !== this.count;
    if (countChanged) {
      this.reset();
      this.count = count;
      this.spacing = Math.log2(HIGH_HZ / LOW_HZ) / (count - 1);
      for (let b = 0; b < count; b++) {
        const f = LOW_HZ * Math.pow(2, b * this.spacing);
        this.modG[b] = Math.tan((Math.PI * Math.min(f, 0.45 * sr)) / sr);
        this.bandHz[b] = f;
      }
    }
    if (countChanged || formant !== this.formant) {
      this.formant = formant;
      const shift = Math.pow(2, formant / 12);
      for (let b = 0; b < count; b++) {
        const f = (this.bandHz[b] as number) * shift;
        this.carG[b] = Math.tan((Math.PI * Math.min(f, 0.45 * sr)) / sr);
      }
    }
    this.width = width;
    // Two stages that meet their neighbours at −3 dB: each stage is 0.64 × the touching Q.
    const touching = 1 / (Math.pow(2, this.spacing / 2) - Math.pow(2, -this.spacing / 2));
    const q = (0.6436 * touching) / width;
    for (let b = 0; b < count; b++) {
      coefficients(this.mod, 4 * b, this.modG[b] as number, q);
      coefficients(this.car, 4 * b, this.carG[b] as number, q);
    }
  }

  private ballistics(attack: number, release: number): void {
    if (attack === this.attack && release === this.release) return;
    this.attack = attack;
    this.release = release;
    this.attackCoef = 1 - Math.exp(-1000 / (attack * this.sampleRate));
    this.releaseCoef = 1 - Math.exp(-1000 / (release * this.sampleRate));
  }

  /** Silence must not leave denormals in the filters. */
  private flushStates(count: number): void {
    for (let i = 0; i < 4 * count; i++) {
      if (!(Math.abs(this.modState[i] as number) > 1e-20)) this.modState[i] = 0;
      if (!(Math.abs(this.leftState[i] as number) > 1e-20)) this.leftState[i] = 0;
      if (!(Math.abs(this.rightState[i] as number) > 1e-20)) this.rightState[i] = 0;
    }
    for (let b = 0; b < count; b++) if (!((this.env[b] as number) > 1e-20)) this.env[b] = 0;
  }
}

/**
 * Cytomic SVF band-pass coefficients (unity gain at the centre) into `out` at `o`, from g = tan(πf/sr)
 * and the Q: a1, a2 = g·a1, 2g, and k (the damping, 1/Q).
 */
function coefficients(out: Float64Array, o: number, g: number, q: number): void {
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  out[o] = a1;
  out[o + 1] = g * a1;
  out[o + 2] = 2 * g;
  out[o + 3] = k;
}
