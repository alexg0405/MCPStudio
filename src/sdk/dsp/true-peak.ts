// True-peak detection (ITU-R BS.1770 style 4× oversampling). Allocation-free; usable on any thread.

const PHASES = 4;
const TAPS_PER_PHASE = 16;
/** Kaiser window β of the interpolation filter. */
const BETA = 7;

/** Zeroth-order modified Bessel function (for the Kaiser window). */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * The polyphase 4× interpolation filter: phase p (0–3) reconstructs the point p/4 of a sample
 * after the sample `TruePeak.LATENCY` frames back. A windowed sinc cut off at the original Nyquist
 * frequency, so phase 0 is the sample itself, exactly.
 */
function interpolationFilter(): Float64Array[] {
  const length = PHASES * TAPS_PER_PHASE + 1;
  const center = (length - 1) / 2;
  const phases = Array.from({ length: PHASES }, () => new Float64Array(TAPS_PER_PHASE + 1));
  const norm = bessel0(BETA);
  for (let i = 0; i < length; i++) {
    const t = (i - center) / PHASES;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (i - center) / center;
    const window = bessel0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
    (phases[i % PHASES] as Float64Array)[Math.floor(i / PHASES)] = sinc * window;
  }
  return phases;
}

const FILTER = interpolationFilter();

/**
 * A true-peak detector: the level the signal really reaches between its samples (where a DAC or
 * a lossy encoder would clip), found by 4× oversampling with a 64-tap interpolation filter.
 * `process(x)` returns the true peak of the stretch from the sample fed `LATENCY` frames ago up
 * to the one after it. Feed it with a delay line of `LATENCY` frames in a look-ahead limiter.
 */
export class TruePeak {
  /** Frames between feeding a sample and getting the peak around it. */
  static readonly LATENCY = TAPS_PER_PHASE / 2;
  private readonly history = new Float64Array(2 * (TAPS_PER_PHASE + 1));
  private pos = 0;

  /** Feeds one sample; returns |peak| of the reconstructed signal around the sample LATENCY frames back. */
  process(x: number): number {
    const len = TAPS_PER_PHASE + 1;
    // A doubled ring: the newest `len` samples are always contiguous at [pos, pos + len).
    this.pos = this.pos > 0 ? this.pos - 1 : len - 1;
    this.history[this.pos] = x;
    this.history[this.pos + len] = x;
    const h = this.history;
    const at = this.pos;
    // Phase 0 is the sample itself (LATENCY frames back).
    const s = h[at + TruePeak.LATENCY] as number;
    let peak = s < 0 ? -s : s;
    for (let p = 1; p < PHASES; p++) {
      const c = FILTER[p] as Float64Array;
      let y = 0;
      // Tap m multiplies the sample m frames back (the filter's taps are symmetric around LATENCY).
      for (let m = 0; m < TAPS_PER_PHASE; m++) y += (c[m] as number) * (h[at + m] as number);
      const a = y < 0 ? -y : y;
      if (a > peak) peak = a;
    }
    return peak;
  }

  reset(): void {
    this.history.fill(0);
    this.pos = 0;
  }
}
