/**
 * Folding an FFT power spectrum into bands (1/6 octave for the spectrum display, the eight tonal bands of the
 * reference), and the display math: tilt, level in dB, the reference's tonal balance drawn as a curve. Pure.
 *
 * The audio thread publishes linear power per bin scaled so a full-scale sine in both channels reads 1 in its bin
 * (see `StereoSpectrum`); a Hann window spreads a sine over 1.5 bins of power, so dividing by that gives a density
 * whose sum over a band is the band's power: a sine reads 0 dB in whatever band holds it, however the bands cut
 * the bins, and bands narrower than a bin share it by their width.
 */

/** Hann window: the power of a sine summed over its bins is this many times its peak bin. */
const HANN_POWER_BINS = 1.5;

/** A set of frequency bands: how many, and the centre and edges of each in Hz. */
export interface BandSet {
  count: number;
  /** Centre frequency and edges (Hz) of each band. */
  centers: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
}

/** Edges for bands of 1/`perOctave` octave from `fMin` up to at most `fMax` (the last band ends at or under it). */
export function octaveEdges(perOctave = 6, fMin = 20, fMax = 20000): number[] {
  const edges: number[] = [];
  for (let i = 0; ; i++) {
    const f = fMin * Math.pow(2, i / perOctave);
    if (f > fMax * 1.0001) break;
    edges.push(f);
  }
  return edges;
}

/** Folds bins into bands with fractional edge weights. Make one per sample rate and FFT size, use it every frame. */
export class BandMap implements BandSet {
  readonly count: number;
  readonly centers: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  private readonly first: Int32Array;
  private readonly offset: Int32Array;
  private readonly weights: Float32Array;

  /** Bands between consecutive `edges` (Hz). `fftSize` is the transform size: bins are `sampleRate / fftSize` apart. */
  constructor(edges: readonly number[], sampleRate: number, fftSize: number) {
    this.count = Math.max(0, edges.length - 1);
    this.centers = new Float64Array(this.count);
    this.lo = new Float64Array(this.count);
    this.hi = new Float64Array(this.count);
    this.first = new Int32Array(this.count);
    this.offset = new Int32Array(this.count + 1);
    const binHz = sampleRate / fftSize;
    const bins = fftSize / 2;
    const weights: number[] = [];
    for (let b = 0; b < this.count; b++) {
      const lo = edges[b] as number;
      const hi = edges[b + 1] as number;
      this.lo[b] = lo;
      this.hi[b] = hi;
      this.centers[b] = Math.sqrt(lo * hi);
      const a = Math.max(0.5, lo / binHz);
      const z = Math.min(bins - 0.5, hi / binHz);
      const k0 = Math.max(1, Math.round(a));
      const k1 = Math.min(bins - 1, Math.round(z));
      this.first[b] = k0;
      this.offset[b] = weights.length;
      for (let k = k0; k <= k1; k++) weights.push(Math.max(0, Math.min(z, k + 0.5) - Math.max(a, k - 0.5)) / HANN_POWER_BINS);
    }
    this.offset[this.count] = weights.length;
    this.weights = Float32Array.from(weights);
  }

  /** Power of each band (linear, a full-scale sine = 1) from the bins' power. */
  fold(power: ArrayLike<number>, out: Float64Array): void {
    for (let b = 0; b < this.count; b++) {
      let sum = 0;
      const k0 = this.first[b] as number;
      const from = this.offset[b] as number;
      const to = this.offset[b + 1] as number;
      for (let i = from; i < to; i++) sum += (this.weights[i] as number) * (power[k0 + i - from] as number);
      out[b] = sum;
    }
  }
}

/** Power as dB (10·log10), floored at `floor`. */
export function powerToDb(p: number, floor = -120): number {
  return p > 0 ? Math.max(floor, 10 * Math.log10(p)) : floor;
}

/** The tilt a slope setting adds at `hz`: `slope` dB per octave around 1 kHz (positive lifts the highs). */
export function tiltDb(hz: number, slope: number): number {
  return slope * Math.log2(hz / 1000);
}

/** Shares of the energy per band in dB under the total (the reference's own way of storing a tonal balance). */
export function sharesDb(bandPower: ArrayLike<number>, floor = -60): number[] {
  let total = 0;
  for (let i = 0; i < bandPower.length; i++) total += bandPower[i] as number;
  const out: number[] = [];
  for (let i = 0; i < bandPower.length; i++) {
    const e = bandPower[i] as number;
    out.push(total > 0 && e > 0 ? Math.max(floor, 10 * Math.log10(e / total)) : floor);
  }
  return out;
}

/**
 * A reference's tonal balance (its eight bands' shares in dB under the total, split at `crossovers`) as a level in
 * each display band, to draw over the live spectrum: a tonal band's energy is spread evenly over the display bands
 * (the 1/6-octave ones) it covers, and the whole is placed so its total power is `totalDb` (the live signal's).
 * Display bands outside the reference's range read `floor`.
 */
export function referenceCurve(shares: ArrayLike<number>, crossovers: readonly number[], bands: BandSet, totalDb: number, floor = -120): Float64Array {
  const out = new Float64Array(bands.count).fill(floor);
  if (shares.length !== crossovers.length + 1 || !Number.isFinite(totalDb)) return out;
  const edges = [0, ...crossovers, Infinity];
  const owner = new Int32Array(bands.count);
  const counts = new Float64Array(shares.length);
  for (let b = 0; b < bands.count; b++) {
    let t = 0;
    while (t < shares.length - 1 && (bands.centers[b] as number) >= (edges[t + 1] as number)) t++;
    owner[b] = t;
    counts[t] = (counts[t] as number) + 1;
  }
  for (let b = 0; b < bands.count; b++) {
    const t = owner[b] as number;
    const share = shares[t] as number;
    if (share <= -59.9) continue;
    out[b] = totalDb + share - 10 * Math.log10(counts[t] as number);
  }
  return out;
}
