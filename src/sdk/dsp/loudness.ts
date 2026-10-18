// Loudness metering after ITU-R BS.1770 / EBU R128 (LUFS). Allocation-free after construction;
// usable on any thread.

/** A biquad in direct form I (the K-weighting stages; coefficients normalized by a0). */
class Stage {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  process(x: number): number {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    if (!(Math.abs(y) > 1e-30)) y = 0;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/**
 * The BS.1770 K-weighting filter (a high shelf for the head, then the "RLB" high-pass), designed
 * for any sample rate from the analog prototypes; at 48 kHz it matches the standard's coefficients.
 */
export class KWeighting {
  private readonly shelf: Stage;
  private readonly highpass: Stage;

  constructor(sampleRate: number) {
    {
      const f0 = 1681.974450955533;
      const gain = 3.999843853973347;
      const q = 0.7071752369554196;
      const k = Math.tan((Math.PI * f0) / sampleRate);
      const vh = Math.pow(10, gain / 20);
      const vb = Math.pow(vh, 0.4996667741545416);
      const a0 = 1 + k / q + k * k;
      this.shelf = new Stage(
        (vh + (vb * k) / q + k * k) / a0,
        (2 * (k * k - vh)) / a0,
        (vh - (vb * k) / q + k * k) / a0,
        (2 * (k * k - 1)) / a0,
        (1 - k / q + k * k) / a0,
      );
    }
    {
      const f0 = 38.13547087602444;
      const q = 0.5003270373238773;
      const k = Math.tan((Math.PI * f0) / sampleRate);
      const a0 = 1 + k / q + k * k;
      this.highpass = new Stage(1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0);
    }
  }

  process(x: number): number {
    return this.highpass.process(this.shelf.process(x));
  }

  reset(): void {
    this.shelf.reset();
    this.highpass.reset();
  }
}

/** Loudness of a mean square (channel weights applied): −0.691 + 10·log10(z). */
export function loudnessOf(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity;
}

/** Blocks of 100 ms: momentary loudness spans 4, short-term 30. */
const MOMENTARY_BLOCKS = 4;
const SHORT_TERM_BLOCKS = 30;
/** Gating (BS.1770-4): absolute −70 LUFS, then −10 LU under the ungated mean. */
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;
/** Integrated-loudness histogram: 0.05 LU bins from the absolute gate up to +10 LUFS. */
const BIN_LU = 0.05;
const HISTOGRAM_TOP = 10;
/** Loudness range (EBU Tech 3342): short-term values above −70 LUFS, then 20 LU under their power mean; the 10th to 95th percentile. */
const RANGE_GATE = -20;
const RANGE_LOW_PERCENTILE = 0.1;
const RANGE_HIGH_PERCENTILE = 0.95;

/**
 * Loudness meter (BS.1770-4, EBU R128): momentary (400 ms), short-term (3 s), integrated
 * (gated, since the last reset) loudness in LUFS and loudness range (LRA, EBU Tech 3342), from K-weighted
 * mean squares in 100 ms steps.
 * Stereo channels count fully (G = 1). Values are −Infinity until there is something to measure.
 */
export class LoudnessMeter {
  /** Loudness over the last 400 ms. */
  momentary = -Infinity;
  /** Loudness over the last 3 s. */
  shortTerm = -Infinity;
  /** Gated loudness of everything since the last reset. */
  integrated = -Infinity;
  private readonly filters: KWeighting[];
  private readonly hop: number;
  /** Mean squares of the last SHORT_TERM_BLOCKS 100 ms blocks (a ring). */
  private readonly blocks = new Float64Array(SHORT_TERM_BLOCKS);
  private blockPos = 0;
  private blockCount = 0;
  private acc = 0;
  private accFrames = 0;
  /** Blocks counted before this one don't join the integrated measurement (after resetIntegrated). */
  private gateFrom = 0;
  /** Histogram of 400 ms gating blocks: count and summed mean square per bin. */
  private readonly binCount: Float64Array;
  private readonly binPower: Float64Array;
  /** The same for the short-term values (every 100 ms), for the loudness range. */
  private readonly rangeCount: Float64Array;
  private readonly rangePower: Float64Array;
  /** Short-term values from blocks counted before this one don't join the loudness range (after resetIntegrated). */
  private rangeFrom = 0;

  constructor(
    readonly sampleRate: number,
    readonly channels = 2,
  ) {
    this.filters = Array.from({ length: Math.max(1, channels) }, () => new KWeighting(sampleRate));
    this.hop = Math.max(1, Math.round(sampleRate / 10));
    const bins = Math.ceil((HISTOGRAM_TOP - ABSOLUTE_GATE) / BIN_LU);
    this.binCount = new Float64Array(bins);
    this.binPower = new Float64Array(bins);
    this.rangeCount = new Float64Array(bins);
    this.rangePower = new Float64Array(bins);
  }

  /** Feeds one frame (`right` is ignored by a one-channel meter). */
  process(left: number, right = 0): void {
    const l = (this.filters[0] as KWeighting).process(left);
    let z = l * l;
    if (this.channels > 1) {
      const r = (this.filters[1] as KWeighting).process(right);
      z += r * r;
    }
    this.acc += z;
    if (++this.accFrames >= this.hop) this.endBlock();
  }

  reset(): void {
    for (const f of this.filters) f.reset();
    this.blocks.fill(0);
    this.blockPos = 0;
    this.blockCount = 0;
    this.acc = 0;
    this.accFrames = 0;
    this.binCount.fill(0);
    this.binPower.fill(0);
    this.rangeCount.fill(0);
    this.rangePower.fill(0);
    this.gateFrom = 0;
    this.rangeFrom = 0;
    this.momentary = this.shortTerm = this.integrated = -Infinity;
  }

  /** Forgets the integrated loudness and the loudness range: a new measurement of what comes from now on. */
  resetIntegrated(): void {
    this.binCount.fill(0);
    this.binPower.fill(0);
    this.rangeCount.fill(0);
    this.rangePower.fill(0);
    this.integrated = -Infinity;
    // The gating blocks overlap by 300 ms: wait until one is made of new audio only.
    this.gateFrom = this.blockCount + MOMENTARY_BLOCKS;
    this.rangeFrom = this.blockCount + SHORT_TERM_BLOCKS;
  }

  /**
   * Loudness range (LRA) in LU of everything since the last reset: the spread of the short-term loudness
   * (10th to 95th percentile of the values that pass the −70 LUFS and −20 LU gates), EBU Tech 3342. 0 until
   * there is a short-term value above the gates. Computed on demand (it scans the histogram).
   */
  get range(): number {
    return loudnessRangeOf(this.rangeCount, this.rangePower);
  }

  private endBlock(): void {
    this.blocks[this.blockPos] = this.acc / this.accFrames;
    this.blockPos = (this.blockPos + 1) % SHORT_TERM_BLOCKS;
    this.blockCount++;
    this.acc = 0;
    this.accFrames = 0;
    const m = this.mean(MOMENTARY_BLOCKS);
    this.momentary = this.blockCount >= MOMENTARY_BLOCKS ? loudnessOf(m) : -Infinity;
    this.shortTerm = this.blockCount >= SHORT_TERM_BLOCKS ? loudnessOf(this.mean(SHORT_TERM_BLOCKS)) : -Infinity;
    // Every 100 ms a 400 ms gating block (75 % overlap) joins the integrated measurement.
    if (this.blockCount >= MOMENTARY_BLOCKS && this.blockCount >= this.gateFrom) {
      const level = loudnessOf(m);
      if (level > ABSOLUTE_GATE) {
        const bin = Math.min(this.binCount.length - 1, Math.floor((level - ABSOLUTE_GATE) / BIN_LU));
        this.binCount[bin] = (this.binCount[bin] as number) + 1;
        this.binPower[bin] = (this.binPower[bin] as number) + m;
      }
      this.integrated = this.gated();
    }
    if (this.blockCount >= SHORT_TERM_BLOCKS && this.blockCount >= this.rangeFrom) {
      const level = this.shortTerm;
      if (level > ABSOLUTE_GATE) {
        const bin = Math.min(this.rangeCount.length - 1, Math.floor((level - ABSOLUTE_GATE) / BIN_LU));
        this.rangeCount[bin] = (this.rangeCount[bin] as number) + 1;
        this.rangePower[bin] = (this.rangePower[bin] as number) + this.mean(SHORT_TERM_BLOCKS);
      }
    }
  }

  /** Mean of the last `count` block mean squares. */
  private mean(count: number): number {
    let sum = 0;
    for (let i = 1; i <= count; i++)
      sum += this.blocks[(this.blockPos - i + SHORT_TERM_BLOCKS) % SHORT_TERM_BLOCKS] as number;
    return sum / count;
  }

  private gated(): number {
    let n = 0;
    let power = 0;
    for (let b = 0; b < this.binCount.length; b++) {
      n += this.binCount[b] as number;
      power += this.binPower[b] as number;
    }
    if (n === 0) return -Infinity;
    const threshold = loudnessOf(power / n) + RELATIVE_GATE;
    const from = Math.max(0, Math.floor((threshold - ABSOLUTE_GATE) / BIN_LU));
    n = 0;
    power = 0;
    for (let b = from; b < this.binCount.length; b++) {
      n += this.binCount[b] as number;
      power += this.binPower[b] as number;
    }
    return n > 0 ? loudnessOf(power / n) : -Infinity;
  }
}

/** LRA from a histogram of short-term values (count and summed mean square per 0.05 LU bin from −70 LUFS). */
export function loudnessRangeOf(count: Float64Array, power: Float64Array): number {
  let n = 0;
  let sum = 0;
  for (let b = 0; b < count.length; b++) {
    n += count[b] as number;
    sum += power[b] as number;
  }
  if (n === 0) return 0;
  const threshold = loudnessOf(sum / n) + RANGE_GATE;
  const from = Math.max(0, Math.floor((threshold - ABSOLUTE_GATE) / BIN_LU));
  let kept = 0;
  for (let b = from; b < count.length; b++) kept += count[b] as number;
  if (kept === 0) return 0;
  const percentile = (fraction: number): number => {
    const goal = fraction * kept;
    let seen = 0;
    for (let b = from; b < count.length; b++) {
      seen += count[b] as number;
      if (seen >= goal && (count[b] as number) > 0) return ABSOLUTE_GATE + (b + 0.5) * BIN_LU;
    }
    return ABSOLUTE_GATE + (count.length - 0.5) * BIN_LU;
  };
  return Math.max(0, percentile(RANGE_HIGH_PERCENTILE) - percentile(RANGE_LOW_PERCENTILE));
}
