import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../fft';
import { dbToAmp } from './math';

/** Frame length of the onset spectra (s, rounded up to a power of two samples, at least 256). */
const FRAME_SEC = 0.02;
const MIN_FRAME_SAMPLES = 256;
/** Quarter-octave bands from 30 Hz up to 16 kHz (or 95 % of Nyquist). */
const LOWEST_BAND_HZ = 30;
const HIGHEST_BAND_HZ = 16000;
const NYQUIST_SHARE = 0.95;
const BAND_RATIO = Math.pow(2, 0.25);
/** Mean |X| of unit-RMS white noise is this × √(Σ window²): scales the noise floor to a spectrum magnitude. */
const NOISE_MAGNITUDE_FACTOR = 0.886;
/** The knee never drops more than this far under the loudest moment (dB), so a silent noise floor still has one. */
const KNEE_FLOOR_DB = -50;
/** Each frame is compared with the one this many frames back (20 ms at the usual hop). */
const COMPARE_LAG_FRAMES = 2;

/** The FFT bin at which each band starts, plus one final edge: band b spans bins [edges[b], edges[b + 1]). */
function quarterOctaveBinEdges(sampleRate: number, fftSize: number, bins: number): number[] {
  const top = Math.min(HIGHEST_BAND_HZ, NYQUIST_SHARE * (sampleRate / 2));
  const edges: number[] = [];
  for (let f = LOWEST_BAND_HZ; f <= top; f *= BAND_RATIO) {
    const bin = Math.max(1, Math.round((f * fftSize) / sampleRate));
    if (edges.length === 0 || bin > (edges[edges.length - 1] as number)) edges.push(bin);
  }
  const topBin = Math.min(bins - 1, Math.round((top * fftSize) / sampleRate));
  if (topBin > (edges[edges.length - 1] as number)) edges.push(topBin);
  return edges;
}

/**
 * Onset detection function: spectral flux of log-compressed band magnitudes, one value per frame
 * (frame i is centered at i × `hopSamples`). A value is the mean, over bands, of how much the band
 * grew compared with 20 ms earlier. The log is `log(1 + magnitude / knee)` with the knee just above
 * the noise floor, so noise wobble barely registers and a quiet hat counts as much as a loud kick.
 */
export function onsetFlux(
  samples: Float32Array,
  sampleRate: number,
  hopSamples: number,
  noise: number,
  peakLevel: number,
): Float32Array {
  const frameSize = Math.max(MIN_FRAME_SAMPLES, nextPowerOfTwo(Math.round(FRAME_SEC * sampleRate)));
  const fft = new RealFFT(frameSize);
  const window = hannWindow(frameSize);
  const magnitudes = new Float32Array(fft.bins);
  const edges = quarterOctaveBinEdges(sampleRate, frameSize, fft.bins);
  const bands = Math.max(0, edges.length - 1);

  let windowEnergy = 0;
  for (let i = 0; i < frameSize; i++) windowEnergy += (window[i] as number) * (window[i] as number);
  const noiseMagnitude = NOISE_MAGNITUDE_FACTOR * Math.sqrt(windowEnergy);
  const knee = Math.max(2 * noise, peakLevel * dbToAmp(KNEE_FLOOR_DB)) * noiseMagnitude;
  const invKnee = 1 / Math.max(knee, 1e-12);

  // Rise against the frame two back (20 ms), so an attack between two frames isn't split in half.
  // `rows` keeps the last three frames' band values in a ring.
  const lag = COMPARE_LAG_FRAMES;
  const rows = new Float32Array((lag + 1) * Math.max(1, bands));
  const flux = new Float32Array(Math.floor((samples.length - 1) / hopSamples) + 1);
  for (let i = 0; i < flux.length; i++) {
    magnitudeSpectrum(fft, samples, i * hopSamples - frameSize / 2, window, magnitudes);
    const current = (i % (lag + 1)) * bands;
    const old = ((i + 1) % (lag + 1)) * bands; // frame i − lag
    let sum = 0;
    for (let b = 0; b < bands; b++) {
      const lo = edges[b] as number;
      const hi = edges[b + 1] as number;
      let bandSum = 0;
      for (let k = lo; k < hi; k++) bandSum += magnitudes[k] as number;
      const logLevel = Math.log1p((bandSum / (hi - lo)) * invKnee);
      const rise = logLevel - (i >= lag ? (rows[old + b] as number) : 0);
      if (rise > 0) sum += rise;
      rows[current + b] = logLevel;
    }
    flux[i] = bands > 0 ? sum / bands : 0;
  }
  return flux;
}
