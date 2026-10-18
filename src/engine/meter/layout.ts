/**
 * What the metering worklet and the main thread share: the processor's name (kept apart so the main thread needn't
 * load the kernel), the slots of the readings array (a Float64Array on a SharedArrayBuffer: the audio thread writes
 * the measurements, the frame loop reads them; the main thread writes the controls), and the sizes of the other
 * shared buffers. Pure constants, no DOM.
 */
export const METER_ID = 'agstudio.meter';

/** Slots of the readings array. */
export const R = {
  /** Render quanta processed since the node was made (a closed meter's count stands still). */
  blocks: 0,
  /** BS.1770 loudness in LUFS (−Infinity until there is something to measure). */
  momentary: 1,
  shortTerm: 2,
  integrated: 3,
  /** Loudness range (LRA) in LU. */
  range: 4,
  /** True peak, dBTP: the maximum since the last reset, per channel. */
  truePeakL: 5,
  truePeakR: 6,
  /** True peak, dBTP: right now (falls 20 dB per second). */
  peakL: 7,
  peakR: 8,
  /** The loudest momentary and short-term values since the last reset (LUFS). */
  maxMomentary: 9,
  maxShortTerm: 10,
  /** Stereo correlation −1…+1 (0.3 s), and the share of the side signal in each band: side / (mid + side), 0…1. */
  correlation: 11,
  widthLow: 12,
  widthMid: 13,
  widthHigh: 14,
  /** Correlation of the bass band alone, and how much quieter the bass gets summed to mono (dB, ≤ 0). */
  corrLow: 15,
  monoLossLow: 16,
  /** How much quieter the whole mix gets summed to mono (dB, ≤ 0). */
  monoLoss: 17,
  /** Level of the bass band (dBFS, RMS of the two channels), to tell a real out-of-phase bass from silence. */
  levelLow: 18,
  /** Loudness history: points written since the node was made, and the count at the last reset (the graph starts there). */
  histCount: 19,
  histStart: 20,
  /** Frames written into the scope ring (the newest is at this index modulo SCOPE_FRAMES), spectra written. */
  scopePos: 21,
  spectrumSeq: 22,
  /** Sample rate of the context. */
  sampleRate: 23,
  // ---- controls (the main thread writes these) ----
  /** 0: loudness, peaks and correlation only; 1: also bands, the spectrum and the goniometer. */
  detail: 24,
  /** Bumped to restart the integrated loudness, the loudness range and the maximums. */
  resetSeq: 25,
  /** 1: the processor ends. */
  closed: 26,
} as const;
/** Slots (Float64) of the readings array. */
export const READINGS_LENGTH = 32;

/** FFT size of the spectrum analysis (frames). */
export const SPECTRUM_SIZE = 8192;
/** Frames between two spectrum analyses. */
export const SPECTRUM_HOP = 2048;
/** Bins of the shared spectrum (linear power, `StereoSpectrum` scaling). */
export const SPECTRUM_BINS = SPECTRUM_SIZE / 2;
/** Frames of the goniometer ring (left and right interleaved). */
export const SCOPE_FRAMES = 2048;
/** Points of the loudness history (momentary and short-term every 100 ms: 20 minutes). */
export const HISTORY_CAPACITY = 12000;
/** Seconds between two points of the loudness history. */
export const HISTORY_STEP_SECONDS = 0.1;

/** Band edges for the stereo width and the bass phase check (Hz). */
export const BAND_LOW_HZ = 150;
/** The upper edge of the mid band (Hz). */
export const BAND_HIGH_HZ = 2000;

/** The shared memory of one meter. */
export interface MeterMemory {
  readings: SharedArrayBuffer;
  history: SharedArrayBuffer;
  spectrum: SharedArrayBuffer;
  scope: SharedArrayBuffer;
}

/** The shared memory of one meter as typed arrays. */
export interface MeterViews {
  readings: Float64Array;
  /** momentary, short-term per point (HISTORY_CAPACITY points, a ring indexed by point number). */
  history: Float32Array;
  spectrum: Float32Array;
  scope: Float32Array;
}

/** Allocates the shared memory of one meter (the processor gets it, the main thread keeps views of it). */
export function allocateMeterMemory(): MeterMemory {
  return {
    readings: new SharedArrayBuffer(READINGS_LENGTH * 8),
    history: new SharedArrayBuffer(HISTORY_CAPACITY * 2 * 4),
    spectrum: new SharedArrayBuffer(SPECTRUM_BINS * 4),
    scope: new SharedArrayBuffer(SCOPE_FRAMES * 2 * 4),
  };
}

/** Typed views of a meter's shared memory. */
export function viewsOf(m: MeterMemory): MeterViews {
  return {
    readings: new Float64Array(m.readings),
    history: new Float32Array(m.history),
    spectrum: new Float32Array(m.spectrum),
    scope: new Float32Array(m.scope),
  };
}

/** Plain arrays of the same shape (Node tests of the kernel). */
export function plainViews(): MeterViews {
  return {
    readings: new Float64Array(READINGS_LENGTH),
    history: new Float32Array(HISTORY_CAPACITY * 2),
    spectrum: new Float32Array(SPECTRUM_BINS),
    scope: new Float32Array(SCOPE_FRAMES * 2),
  };
}

/** The readings of a meter that has measured nothing yet: no loudness, no peaks (−Infinity), correlation 0. */
export function initReadings(r: Float64Array, sampleRate = 0): void {
  r[R.momentary] = r[R.shortTerm] = r[R.integrated] = -Infinity;
  r[R.truePeakL] = r[R.truePeakR] = r[R.peakL] = r[R.peakR] = -Infinity;
  r[R.maxMomentary] = r[R.maxShortTerm] = -Infinity;
  r[R.levelLow] = -Infinity;
  r[R.sampleRate] = sampleRate;
}
