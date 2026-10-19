import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../fft';
import { VOICE_THRESHOLDS } from './thresholds';
import type { Onset, VoiceFeatures } from './types';

const T = VOICE_THRESHOLDS;

/** The energy "below 150 Hz" and "above 4 kHz" ratios use these edges (Hz). */
const LOW_EDGE_HZ = 150;
const HIGH_EDGE_HZ = 4000;
/** Bands between the two low edges and 4 kHz are third octaves: edge k is 4 kHz × 2^(k/3), from k = −11. */
const FIRST_THIRD_OCTAVE_STEP = -11;

/** The attack window rises over this long (s) and then falls as a half cosine. */
const ATTACK_RISE_SEC = 0.002;

/** The background is read from 23 ms to 3 ms before the onset (s)… */
const BACKGROUND_FROM_SEC = 0.023;
const BACKGROUND_TO_SEC = 0.003;
/** …but only when at least this much room is left after the previous onset (s)… */
const BACKGROUND_MIN_SEC = 0.005;
/** …and the previous onset's own attack (this long, s) is left out. */
const PREVIOUS_ONSET_GUARD_SEC = 0.01;
/** Subtract the background only when at least this share of the raw energy is left over. */
const MIN_REMAINING_SHARE = 0.05;

type WindowKind = 'attack' | 'hann';

interface CachedWindow {
  w: Float64Array;
  /** Sum of squares, floored so a normalisation never divides by zero. */
  energy: number;
}

/** The frequency bands the feature spectra are summed into. */
interface FeatureBands {
  /** Geometric center of each band (Hz). */
  centerHz: Float64Array;
  /** The band each FFT bin belongs to, −1 for bins outside every band. */
  bandOfBin: Int8Array;
  /** The first band over 4 kHz. */
  firstHighBand: number;
}

/** Band edges: 30–150 Hz, 150–315 Hz, then third octaves with an edge at 4 kHz, up to Nyquist. */
function bandEdges(sampleRate: number): { edges: number[]; firstHighBand: number } {
  const edges = [T.highPassHz, LOW_EDGE_HZ];
  let highBand = -1;
  for (let k = FIRST_THIRD_OCTAVE_STEP; ; k++) {
    const f = HIGH_EDGE_HZ * Math.pow(2, k / 3);
    if (f >= sampleRate / 2) break;
    if (k === 0) highBand = edges.length;
    edges.push(f);
  }
  edges.push(sampleRate / 2);
  return { edges, firstHighBand: highBand };
}

function buildFeatureBands(sampleRate: number, fft: RealFFT): FeatureBands {
  const { edges, firstHighBand } = bandEdges(sampleRate);
  const bands = edges.length - 1;
  const centerHz = new Float64Array(bands);
  for (let b = 0; b < bands; b++) centerHz[b] = Math.sqrt((edges[b] as number) * (edges[b + 1] as number));
  const bandOfBin = new Int8Array(fft.bins).fill(-1);
  const binHz = sampleRate / fft.size;
  for (let k = 1, b = 0; k < fft.bins; k++) {
    const f = k * binHz;
    while (b < bands && f >= (edges[b + 1] as number)) b++;
    if (f >= T.highPassHz && b < bands) bandOfBin[k] = b;
  }
  return { centerHz, bandOfBin, firstHighBand: firstHighBand < 0 ? bands : firstHighBand };
}

/**
 * Measures what a sound is made of: its spectrum over the first 60 ms under an attack-weighted
 * window, with the background just before the onset subtracted band by band, summarised as a
 * centroid and energy ratios, plus its zero-crossing rate.
 */
export class SpectralFeatures {
  private readonly fft: RealFFT;
  private readonly power: Float64Array;
  private readonly bands: FeatureBands;
  private readonly bandEnergy: Float64Array;
  private readonly bandBackground: Float64Array;
  private readonly windows = new Map<string, CachedWindow>();

  constructor(
    private readonly samples: Float32Array,
    private readonly sampleRate: number,
  ) {
    this.fft = new RealFFT(Math.max(2, nextPowerOfTwo(Math.round(T.featureSec * sampleRate))));
    this.power = new Float64Array(this.fft.bins);
    this.bands = buildFeatureBands(sampleRate, this.fft);
    this.bandEnergy = new Float64Array(this.bands.centerHz.length);
    this.bandBackground = new Float64Array(this.bands.centerHz.length);
  }

  /**
   * The features of the sound that starts at `onset` and ends at `endSec`. `prevSec` is the
   * previous onset (so its tail is not mistaken for background), `periodicity` the YIN value.
   */
  measure(onset: Onset, prevSec: number, endSec: number, periodicity: number): VoiceFeatures {
    const sampleRate = this.sampleRate;
    const start = Math.round(onset.time * sampleRate);
    const length = Math.max(
      2,
      Math.min(
        Math.round(T.featureSec * sampleRate),
        Math.round((endSec - onset.time) * sampleRate),
        this.samples.length - start,
        this.fft.size,
      ),
    );
    const energy = this.attackSpectrum(onset, prevSec, start, length);
    let total = 0;
    let high = 0;
    let weighted = 0;
    for (let b = 0; b < energy.length; b++) {
      const e = energy[b] as number;
      total += e;
      weighted += e * (this.bands.centerHz[b] as number);
      if (b >= this.bands.firstHighBand) high += e;
    }
    const stop = Math.min(this.samples.length, start + length);
    const crossings = this.countZeroCrossings(start, stop);
    return {
      centroid: total > 0 ? weighted / total : 0,
      lowRatio: total > 0 ? (energy[0] as number) / total : 0,
      highRatio: total > 0 ? high / total : 0,
      zcr: (crossings * sampleRate) / Math.max(1, stop - start),
      periodicity,
    };
  }

  /**
   * The power per band of x[start, start + length) with the background just before the onset
   * (noise, the previous sound's tail) subtracted. A legato note change has no attack, so it keeps
   * the raw spectrum. The returned array is reused by the next call.
   */
  private attackSpectrum(onset: Onset, prevSec: number, start: number, length: number): Float64Array {
    const sampleRate = this.sampleRate;
    const energy = this.bandEnergy;
    this.bandPower(start, length, 'attack', energy);
    if (onset.split) return energy;
    let raw = 0;
    for (let b = 0; b < energy.length; b++) raw += energy[b] as number;
    const backgroundEnd = start - Math.round(BACKGROUND_TO_SEC * sampleRate);
    const backgroundStart = Math.max(
      0,
      start - Math.round(BACKGROUND_FROM_SEC * sampleRate),
      Math.round((prevSec + PREVIOUS_ONSET_GUARD_SEC) * sampleRate),
    );
    if (backgroundEnd - backgroundStart < Math.round(BACKGROUND_MIN_SEC * sampleRate)) return energy;
    const background = this.bandBackground;
    this.bandPower(backgroundStart, backgroundEnd - backgroundStart, 'hann', background);
    let remaining = 0;
    for (let b = 0; b < energy.length; b++) remaining += Math.max(0, (energy[b] as number) - (background[b] as number));
    // Keep the raw spectrum if the event barely stands out of the background.
    if (!(remaining > MIN_REMAINING_SHARE * raw)) return energy;
    for (let b = 0; b < energy.length; b++) energy[b] = Math.max(0, (energy[b] as number) - (background[b] as number));
    return energy;
  }

  /** Counts sign changes in samples [start + 1, stop). */
  private countZeroCrossings(start: number, stop: number): number {
    const x = this.samples;
    let crossings = 0;
    for (let i = Math.max(1, start + 1); i < stop; i++) {
      if ((x[i - 1] as number) < 0 !== (x[i] as number) < 0) crossings++;
    }
    return crossings;
  }

  /** Window of `length` samples: 'attack' rises over 2 ms and falls as a half cosine; 'hann' is Hann. */
  private window(kind: WindowKind, length: number): CachedWindow {
    const key = `${kind}:${length}`;
    const cached = this.windows.get(key);
    if (cached) return cached;
    const w = kind === 'hann' ? hannWindow(length) : this.attackWindow(length);
    let energy = 0;
    for (let i = 0; i < length; i++) energy += (w[i] as number) * (w[i] as number);
    const entry = { w, energy: Math.max(energy, 1e-12) };
    this.windows.set(key, entry);
    return entry;
  }

  private attackWindow(length: number): Float64Array {
    const w = new Float64Array(length);
    const rise = Math.max(1, Math.min(Math.round(ATTACK_RISE_SEC * this.sampleRate), length >> 2));
    for (let i = 0; i < length; i++) {
      w[i] =
        i < rise
          ? 0.5 - 0.5 * Math.cos((Math.PI * i) / rise)
          : 0.5 + 0.5 * Math.cos((Math.PI * (i - rise)) / (length - rise));
    }
    return w;
  }

  /** Writes the power spectrum of x[start, start + length) under `kind`, normalized to mean power, into `bands`. */
  private bandPower(start: number, length: number, kind: WindowKind, bands: Float64Array): void {
    const { w, energy } = this.window(kind, length);
    magnitudeSpectrum(this.fft, this.samples, start, w, this.power, true);
    bands.fill(0);
    const power = this.power;
    const bandOfBin = this.bands.bandOfBin;
    for (let k = 1; k < power.length; k++) {
      const b = bandOfBin[k] as number;
      if (b >= 0) bands[b] = (bands[b] as number) + (power[k] as number) / energy;
    }
  }
}
