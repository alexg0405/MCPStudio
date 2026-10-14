// Polyphase IIR halfband filters for 2× and 4× oversampling (two parallel chains of first-order
// allpass sections, as in Laurent de Soras' HIIR). Allocation-free after construction; usable on
// any thread.

/** Terms of the elliptic-function series (they shrink like q^(n²), so a few are plenty). */
const SERIES_TERMS = 24;

/**
 * Allpass coefficients of an elliptic halfband filter with at least `attenuation` dB of stopband
 * rejection and a transition band `transition` wide, as a fraction of the oversampled rate
 * (0 < transition < 0.5): the passband ends at (0.25 − transition/2)·rate and the stopband starts
 * at (0.25 + transition/2)·rate. Narrower transitions and more attenuation need more coefficients
 * (each costs two multiply-adds per sample).
 */
export function halfbandCoefficients(attenuation: number, transition: number): Float64Array {
  const t = Math.min(0.49, Math.max(1e-4, transition));
  let k = Math.tan(((1 - 2 * t) * Math.PI) / 4);
  k *= k;
  const kk = Math.pow(1 - k * k, 0.25);
  const e = (0.5 * (1 - kk)) / (1 + kk);
  const e4 = e * e * e * e;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  // Filter order for the attenuation (odd, at least 3).
  const power = Math.pow(10, -Math.max(1, attenuation) / 10);
  const a = power / (1 - power);
  let order = Math.ceil(Math.log((a * a) / 16) / Math.log(q));
  if (order % 2 === 0) order++;
  if (order < 3) order = 3;
  const count = (order - 1) / 2;
  const coefs = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const c = index + 1;
    let num = 0;
    for (let i = 0, sign = 1; i < SERIES_TERMS; i++, sign = -sign)
      num += Math.pow(q, i * (i + 1)) * Math.sin(((2 * i + 1) * c * Math.PI) / order) * sign;
    num *= Math.pow(q, 0.25);
    let den = 0;
    for (let i = 1, sign = -1; i < SERIES_TERMS; i++, sign = -sign)
      den += Math.pow(q, i * i) * Math.cos((2 * i * c * Math.PI) / order) * sign;
    den += 0.5;
    const w = num / den;
    const w2 = w * w;
    const x = Math.sqrt((1 - w2 * k) * (1 - w2 / k)) / (1 + w2);
    coefs[index] = (1 - x) / (1 + x);
  }
  return coefs;
}

/** One chain of first-order allpass sections `(a + z⁻¹) / (1 + a·z⁻¹)` at the low rate. */
class AllpassChain {
  private readonly x1: Float64Array;
  private readonly y1: Float64Array;

  constructor(private readonly coefs: Float64Array) {
    this.x1 = new Float64Array(coefs.length);
    this.y1 = new Float64Array(coefs.length);
  }

  process(x: number): number {
    const c = this.coefs;
    let v = x;
    for (let i = 0; i < c.length; i++) {
      let y = (c[i] as number) * (v - (this.y1[i] as number)) + (this.x1[i] as number);
      if (!(Math.abs(y) > 1e-30)) y = 0; // denormals and NaN
      this.x1[i] = v;
      this.y1[i] = y;
      v = y;
    }
    return v;
  }

  reset(): void {
    this.x1.fill(0);
    this.y1.fill(0);
  }
}

/**
 * One 2× halfband stage, H(z) = ½·(A₀(z²) + z⁻¹·A₁(z²)). `up(x)` turns one sample into two (in
 * `even` and `odd`), `down(a, b)` two into one; the two directions keep separate state, so one
 * instance oversamples a signal and brings it back down. Linear-phase it isn't: the phase shift is
 * tiny at low frequencies and grows towards the band edge (no latency to report).
 */
export class Halfband {
  /** The first of the two samples made by the last `up()`. */
  even = 0;
  /** The second of the two samples made by the last `up()`. */
  odd = 0;
  private readonly up0: AllpassChain;
  private readonly up1: AllpassChain;
  private readonly down0: AllpassChain;
  private readonly down1: AllpassChain;

  /** `coefs` from `halfbandCoefficients()`. */
  constructor(readonly coefs: Float64Array) {
    const path = (offset: number) => coefs.filter((_, i) => i % 2 === offset);
    const c0 = path(0);
    const c1 = path(1);
    this.up0 = new AllpassChain(c0);
    this.up1 = new AllpassChain(c1);
    this.down0 = new AllpassChain(c0);
    this.down1 = new AllpassChain(c1);
  }

  /** Interpolates one sample into two at twice the rate (`even`, then `odd`). */
  up(x: number): void {
    this.even = this.up0.process(x);
    this.odd = this.up1.process(x);
  }

  /** Decimates two samples (`a` first, then `b`) at the high rate into one. */
  down(a: number, b: number): number {
    return 0.5 * (this.down0.process(b) + this.down1.process(a));
  }

  reset(): void {
    this.up0.reset();
    this.up1.reset();
    this.down0.reset();
    this.down1.reset();
    this.even = 0;
    this.odd = 0;
  }
}

/** Stage designs: the first one does the hard work; at 4× the second has a much wider transition. */
const STAGE_1 = { attenuation: 100, transition: 0.04 };
const STAGE_2 = { attenuation: 100, transition: 0.25 };

/**
 * Runs a nonlinearity (a saturator, a clipper) at 2× or 4× the sample rate so its harmonics don't
 * fold back as aliasing: `up(x)` fills `buffer[0..factor)`, you shape those samples in place, and
 * `down()` brings them back to one sample. Flat to about 22 kHz at 48 kHz, with 100 dB of image
 * and alias rejection; a factor of 1 passes samples straight through.
 */
export class Oversampler {
  /** The oversampled samples of the current input sample (`factor` of them). */
  readonly buffer = new Float64Array(4);
  private readonly stage1: Halfband;
  private readonly stage2: Halfband;

  constructor(readonly factor: 1 | 2 | 4 = 2) {
    this.stage1 = new Halfband(halfbandCoefficients(STAGE_1.attenuation, STAGE_1.transition));
    this.stage2 = new Halfband(halfbandCoefficients(STAGE_2.attenuation, STAGE_2.transition));
  }

  up(x: number): void {
    const b = this.buffer;
    if (this.factor === 1) {
      b[0] = x;
      return;
    }
    this.stage1.up(x);
    if (this.factor === 2) {
      b[0] = this.stage1.even;
      b[1] = this.stage1.odd;
      return;
    }
    const s2 = this.stage2;
    const odd = this.stage1.odd;
    s2.up(this.stage1.even);
    b[0] = s2.even;
    b[1] = s2.odd;
    s2.up(odd);
    b[2] = s2.even;
    b[3] = s2.odd;
  }

  down(): number {
    const b = this.buffer;
    if (this.factor === 1) return b[0] as number;
    if (this.factor === 2) return this.stage1.down(b[0] as number, b[1] as number);
    const a = this.stage2.down(b[0] as number, b[1] as number);
    const c = this.stage2.down(b[2] as number, b[3] as number);
    return this.stage1.down(a, c);
  }

  reset(): void {
    this.stage1.reset();
    this.stage2.reset();
    this.buffer.fill(0);
  }
}
