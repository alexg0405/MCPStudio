import {
  InstrumentKernel,
  VoicePool,
  at,
  mtof,
  type KernelHost,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import type { pluckParams } from './params';

const MAX_DELAY = 4096;
/** Seconds of sound a pluck's level is judged over. */
const LEVEL_SECONDS = 1;
/** Terms of the Chebyshev fit of the level weight (see levelBurst). */
const LEVEL_DEGREE = 16;
/** Long bursts (low notes) have a flatter weight, so they need fewer terms. */
const LEVEL_DEGREE_LONG = 6;
/** Bursts longer than this (low notes) use LEVEL_DEGREE_LONG. */
const LONG_BURST = 512;
const LEVEL_NODES = LEVEL_DEGREE + 1;
/** Bursts up to this many samples have their level summed bin by bin (see levelBurst). */
const EXACT_BELOW = 160;
/** cos(π·d·(j+½)/M) for the fit's basis, computed once: row d, node j. */
const CHEB_COS = (() => {
  const t = new Float64Array(LEVEL_NODES * LEVEL_NODES);
  for (let d = 0; d < LEVEL_NODES; d++)
    for (let j = 0; j < LEVEL_NODES; j++)
      t[d * LEVEL_NODES + j] = Math.cos((Math.PI * d * (j + 0.5)) / LEVEL_NODES);
  return t;
})();

class PluckVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  buf = new Float32Array(MAX_DELAY);
  len = 1;
  pos = 0;
  /** The burst still needs its level set (done on the first block, when the decay params are known). */
  shape = false;
  /** One-pole coefficient the burst was drawn with. */
  burstA = 1;
  /** One-pole low-pass state in the loop. */
  lp = 0;
  /** First-order all-pass (fractional delay) state. */
  apX = 0;
  apY = 0;
  apC = 0;
  freq = 440;
  amp = 0;
  pan = 0;
  quiet = 0;
}

/**
 * Karplus-Strong plucked string. Built as a worklet kernel because a native Web Audio feedback
 * loop can't be shorter than one 128-frame block (anything above ~375 Hz would be impossible).
 */
export class PluckKernel extends InstrumentKernel<typeof pluckParams> {
  private readonly pool = new VoicePool(16, () => new PluckVoice());
  /** Scratch for levelBurst, allocated once. */
  private readonly levelNodes = new Float64Array(LEVEL_NODES);
  private readonly levelCoef = new Float64Array(LEVEL_NODES);
  private readonly binCos = new Float64Array(EXACT_BELOW + 1);
  private readonly binSin = new Float64Array(EXACT_BELOW + 1);

  constructor(host: KernelHost) {
    super(host);
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    const v = this.pool.start(noteId, key);
    const sr = this.sampleRate;
    // A string's length is fixed while it rings: the note's fine pitch and the channel pitch apply at the pluck.
    v.freq = mtof(key + (fine + at(this.pitch, 0)) / 100);
    // Loop delay = N (buffer) + 0.5 (averaging filter) + d (all-pass) = sr / f.
    const total = Math.min(MAX_DELAY - 1, sr / v.freq);
    const n = Math.max(2, Math.floor(total - 0.5 - 0.01));
    const d = total - 0.5 - n;
    v.len = n;
    v.apC = (1 - d) / (1 + d);
    v.apX = 0;
    v.apY = 0;
    v.pos = 0;
    v.lp = 0;
    v.amp = velocity;
    v.pan = pan;
    v.quiet = 0;
    // Excite with filtered noise; `tone` sets the brightness of the pick.
    const tone = this.lastTone;
    const a = 0.05 + 0.95 * tone;
    let y = 0;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      y += a * (this.host.rand() * 2 - 1 - y);
      v.buf[i] = y;
      mean += y;
    }
    mean /= n;
    for (let i = 0; i < n; i++) v.buf[i] = (v.buf[i] as number) - mean;
    v.shape = true;
    v.burstA = a;
  }

  /**
   * Scales a new burst so the pluck's loudness doesn't depend on the random draw. Each harmonic of
   * the burst has a random power (exponentially distributed), and the level is the sum over the
   * harmonics weighted by how much of each one survives the loop over LEVEL_SECONDS. Summing the
   * random parts swings the level by several dB from seed to seed (most at high pitches, where few
   * harmonics are left). Scale the burst so that sum equals its expected value for this tone.
   *
   * The weight of harmonic k is w(cos 2πk/n). Short bursts (up to EXACT_BELOW samples) sum the bins
   * one by one. Longer ones fit w with a Chebyshev series, so the sum over the bins needs only the
   * burst's circular autocorrelation at a few lags (cos(d·w_k) summed over the bins is n times that
   * lag's value): LEVEL_DEGREE lags up to LONG_BURST samples, LEVEL_DEGREE_LONG beyond, which is
   * the flatter weight of a low note (fewer periods per second). The expected value comes from the
   * tone filter's autocorrelation in closed form, so a long burst costs a handful of passes over it,
   * once per note (about 130 µs for eight notes at keys 24 to 31; test/unit/pluck-cost.test.ts holds
   * that to a budget).
   */
  private levelBurst(v: PluckVoice, t60: number, damp: number): void {
    const n = v.len;
    const buf = v.buf;
    const a = v.burstA;
    const periods = LEVEL_SECONDS * v.freq;
    // Energy per loop period of harmonic k is g² · (|averaging filter| at its frequency)², which is
    // g² (A + B·cos w) with A and B from `damp`.
    const g2 = Math.pow(10, -6 / (t60 * v.freq));
    const A = (1 - damp) * (1 - damp) + damp * damp;
    const B = 2 * damp * (1 - damp);
    let actual = 0;
    let expected = 0;
    if (n <= EXACT_BELOW) {
      // The n-th roots of unity, once per note: bin k of the burst is Σ x_i·e^{−2πjki/n}.
      const cs = this.binCos;
      const sn = this.binSin;
      for (let m = 0; m < n; m++) {
        const ang = (2 * Math.PI * m) / n;
        cs[m] = Math.cos(ang);
        sn[m] = Math.sin(ang);
      }
      // Bins k and n−k carry the same power and weight, so half the bins (counted twice) suffice.
      for (let k = 1; 2 * k <= n; k++) {
        const cw = cs[k] as number;
        const e = g2 * (A + B * cw);
        const weight = (1 - Math.pow(e, periods)) / (1 - e);
        let idx = 0;
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const x = buf[i] as number;
          re += x * (cs[idx] as number);
          im -= x * (sn[idx] as number);
          idx += k;
          if (idx >= n) idx -= n;
        }
        const h2 = (a * a) / (1 - 2 * (1 - a) * cw + (1 - a) * (1 - a));
        const mult = 2 * k === n ? 1 : 2;
        actual += mult * weight * (re * re + im * im);
        expected += mult * weight * h2;
      }
      expected *= n / 3;
    } else {
      const M = LEVEL_NODES;
      const nodes = this.levelNodes;
      const coef = this.levelCoef;
      // Chebyshev interpolation of the weight at the M nodes x_j = cos(π(j+½)/M).
      for (let j = 0; j < M; j++) {
        const e = g2 * (A + B * (CHEB_COS[M + j] as number));
        nodes[j] = (1 - Math.pow(e, periods)) / (1 - e);
      }
      const deg = n > LONG_BURST ? LEVEL_DEGREE_LONG : LEVEL_DEGREE;
      for (let d = 0; d <= deg; d++) {
        let sum = 0;
        for (let j = 0; j < M; j++) sum += (nodes[j] as number) * (CHEB_COS[d * M + j] as number);
        coef[d] = ((d === 0 ? 1 : 2) / M) * sum;
      }
      // The burst's circular autocorrelation at lags 0..deg, weighted by the fit.
      for (let d = 0; d <= deg; d++) {
        let r = 0;
        for (let i = d; i < n; i++) r += (buf[i] as number) * (buf[i - d] as number);
        for (let i = 0; i < d; i++) r += (buf[i] as number) * (buf[i - d + n] as number);
        actual += (coef[d] as number) * r;
      }
      actual *= n;
      // Expected value. For the tone filter's autocorrelation r(d) = a/(2−a)·(1−a)^d/3 the burst's
      // lag sums are E[C'(d)] = (n−d)·r(d) − E[(Σb)²]/n, where E[(Σb)²] = n/3 − (2/3)(1−a)/(a(2−a))
      // (the mean removed from the burst is the lag sums' −E[(Σb)²]/n term).
      const rho = 1 - a;
      const r0 = (a / (2 - a)) / 3;
      const sumSq = n / 3 - (2 / 3) * (rho / (a * (2 - a)));
      let lagSum = 0;
      let coefSum = 0;
      let rPow = 1;
      for (let d = 0; d <= deg; d++) {
        lagSum += (coef[d] as number) * (n - d) * r0 * rPow;
        coefSum += coef[d] as number;
        rPow *= rho;
      }
      expected = n * lagSum - sumSq * coefSum;
    }
    if (actual > 1e-20) {
      const gain = Math.sqrt(expected / actual);
      for (let i = 0; i < n; i++) buf[i] = (buf[i] as number) * gain;
    }
  }

  noteOff(noteId: number): void {
    this.pool.release(noteId);
  }

  override allNotesOff(hard: boolean): void {
    if (hard) this.pool.freeAll();
    else this.pool.releaseAll();
  }

  override reset(): void {
    this.pool.freeAll();
  }

  private lastTone = 0.6;

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<typeof pluckParams>): void {
    const L = out[0] as Float32Array;
    const R = (out[1] ?? out[0]) as Float32Array;
    const sr = this.sampleRate;
    this.lastTone = at(params.tone, from);
    const decay = at(params.decay, from);
    const release = at(params.release, from);
    const damping = at(params.damping, from);
    const width = at(params.width, from);
    const level = Math.pow(10, at(params.level, from) / 20);
    const voices = this.pool.voices;
    for (let vi = 0; vi < voices.length; vi++) {
      const v = voices[vi] as PluckVoice;
      if (!v.active) continue;
      // Loop gain per period for a T60 of `decay` (or `release` once released).
      const t60 = v.releasing ? Math.min(release, decay) : decay;
      const g = Math.pow(10, -3 / (t60 * v.freq));
      const damp = 0.5 + 0.49 * damping;
      if (v.shape) {
        v.shape = false;
        this.levelBurst(v, t60, damp);
      }
      const pan = Math.max(-1, Math.min(1, v.pan + (((v.key * 7) % 12) / 11 - 0.5) * width));
      const gl = v.amp * level * Math.sqrt(0.5 * (1 - pan));
      const gr = v.amp * level * Math.sqrt(0.5 * (1 + pan));
      let peak = 0;
      for (let i = from; i < to; i++) {
        const x = v.buf[v.pos] as number;
        // Averaging low-pass (half-sample delay) blended with damping, then fractional all-pass.
        const avg = x + damp * (v.lp - x);
        v.lp = x;
        const ap = v.apC * avg + v.apX - v.apC * v.apY;
        v.apX = avg;
        v.apY = ap;
        let fb = ap * g;
        if (!(Math.abs(fb) > 1e-20)) fb = 0;
        v.buf[v.pos] = fb;
        v.pos = v.pos + 1 === v.len ? 0 : v.pos + 1;
        L[i] = (L[i] as number) + x * gl;
        R[i] = (R[i] as number) + x * gr;
        const ax = Math.abs(x);
        if (ax > peak) peak = ax;
      }
      // Free voices that have died away.
      v.quiet = peak < 1e-4 ? v.quiet + (to - from) : 0;
      if (v.quiet > sr * 0.05) this.pool.free(v);
    }
  }
}
