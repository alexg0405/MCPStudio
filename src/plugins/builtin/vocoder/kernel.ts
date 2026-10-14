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
 * The filter states live in flat arrays (structure of arrays) so 32 bands stay cheap.
 */
export class VocoderKernel extends EffectKernel<P> {
  // Per band: modulator and carrier coefficients (a1, a2, a3, k of a Cytomic SVF band-pass).
  private readonly mod = new Float64Array(4 * MAX_BANDS);
  private readonly car = new Float64Array(4 * MAX_BANDS);
  // Per band: two stages × (ic1, ic2) for the modulator and each carrier side.
  private readonly modState = new Float64Array(4 * MAX_BANDS);
  private readonly leftState = new Float64Array(4 * MAX_BANDS);
  private readonly rightState = new Float64Array(4 * MAX_BANDS);
  private readonly env = new Float64Array(MAX_BANDS);
  private readonly sibilance = new Svf().set('highpass', SIBILANCE_HZ, Math.SQRT1_2, this.sampleRate);
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
    const mod = this.mod;
    const car = this.car;
    const ms = this.modState;
    const ls = this.leftState;
    const rs = this.rightState;
    const env = this.env;
    // Fewer bands sum quieter: keep the level about the same whatever the count.
    const makeup = MAKEUP * Math.sqrt(24 / count);
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.design(count, at(p.width, i), at(p.formant, i));
        this.ballistics(at(p.attack, i), at(p.release, i));
        const out = at(p.output, i);
        if (out !== this.outDb) {
          this.outDb = out;
          this.outGain = dbToGain(out);
        }
      }
      this.countdown--;
      const m = 0.5 * ((kL[i] as number) + (kR[i] as number));
      const noise = at(p.noise, i) * NOISE_LEVEL * (2 * this.host.rand() - 1);
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      const cl = xl + noise;
      const cr = xr + noise;
      let accL = 0;
      let accR = 0;
      const ac = this.attackCoef;
      const rc = this.releaseCoef;
      for (let b = 0; b < count; b++) {
        const o = 4 * b;
        // Modulator band: two SVF band-pass stages.
        let a1 = mod[o] as number;
        let a2 = mod[o + 1] as number;
        let a3 = mod[o + 2] as number;
        let k = mod[o + 3] as number;
        let ic1 = ms[o] as number;
        let ic2 = ms[o + 1] as number;
        let v3 = m - ic2;
        let v1 = a1 * ic1 + a2 * v3;
        let v2 = ic2 + a2 * ic1 + a3 * v3;
        ms[o] = 2 * v1 - ic1;
        ms[o + 1] = 2 * v2 - ic2;
        let y = k * v1;
        ic1 = ms[o + 2] as number;
        ic2 = ms[o + 3] as number;
        v3 = y - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        ms[o + 2] = 2 * v1 - ic1;
        ms[o + 3] = 2 * v2 - ic2;
        y = k * v1;
        // Its envelope.
        const level = y < 0 ? -y : y;
        const e = env[b] as number;
        const g = e + (level > e ? ac : rc) * (level - e);
        env[b] = g;
        // Carrier bands, left and right.
        a1 = car[o] as number;
        a2 = car[o + 1] as number;
        a3 = car[o + 2] as number;
        k = car[o + 3] as number;
        ic1 = ls[o] as number;
        ic2 = ls[o + 1] as number;
        v3 = cl - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        ls[o] = 2 * v1 - ic1;
        ls[o + 1] = 2 * v2 - ic2;
        y = k * v1;
        ic1 = ls[o + 2] as number;
        ic2 = ls[o + 3] as number;
        v3 = y - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        ls[o + 2] = 2 * v1 - ic1;
        ls[o + 3] = 2 * v2 - ic2;
        accL += k * v1 * g;
        ic1 = rs[o] as number;
        ic2 = rs[o + 1] as number;
        v3 = cr - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        rs[o] = 2 * v1 - ic1;
        rs[o + 1] = 2 * v2 - ic2;
        y = k * v1;
        ic1 = rs[o + 2] as number;
        ic2 = rs[o + 3] as number;
        v3 = y - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        rs[o + 2] = 2 * v1 - ic1;
        rs[o + 3] = 2 * v2 - ic2;
        accR += k * v1 * g;
      }
      const sib = at(p.sibilance, i) * this.sibilance.process(m);
      const gain = this.outGain;
      const mix = at(p.mix, i);
      outL[i] = gain * (xl + mix * (accL * makeup + sib - xl));
      outR[i] = gain * (xr + mix * (accR * makeup + sib - xr));
    }
    this.flushStates(count);
  }

  /** Band frequencies and widths for both banks (only when they change). */
  private design(count: number, width: number, formant: number): void {
    if (count === this.count && width === this.width && formant === this.formant) return;
    if (count !== this.count) this.reset();
    this.count = count;
    this.width = width;
    this.formant = formant;
    const sr = this.sampleRate;
    const span = Math.log2(HIGH_HZ / LOW_HZ);
    const spacing = span / (count - 1);
    // Two stages that meet their neighbours at −3 dB: each stage is 0.64 × the touching Q.
    const touching = 1 / (Math.pow(2, spacing / 2) - Math.pow(2, -spacing / 2));
    const q = (0.6436 * touching) / width;
    const shift = Math.pow(2, formant / 12);
    for (let b = 0; b < count; b++) {
      const f = LOW_HZ * Math.pow(2, b * spacing);
      coefficients(this.mod, 4 * b, f, q, sr);
      coefficients(this.car, 4 * b, f * shift, q, sr);
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

/** Cytomic SVF band-pass coefficients (a1, a2, a3, k; unity gain at the centre) into `out` at `o`. */
function coefficients(out: Float64Array, o: number, freq: number, q: number, sampleRate: number): void {
  const g = Math.tan((Math.PI * Math.min(freq, 0.45 * sampleRate)) / sampleRate);
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  out[o] = a1;
  out[o + 1] = g * a1;
  out[o + 2] = g * g * a1;
  out[o + 3] = k;
}
