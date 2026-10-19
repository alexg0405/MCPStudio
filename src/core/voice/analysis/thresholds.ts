/** Every number the voice analysis tunes by, in one place. */

/**
 * Every threshold the analysis uses, in one place. `[a, b]` pairs depend on `sensitivity`: a at 0,
 * b at 1, linear in between (the default 0.5 is the midpoint). Drum thresholds are soft: each is
 * the 50 % point of a logistic score.
 */
export const VOICE_THRESHOLDS = {
  highPassHz: 30,
  /** Features (spectrum, zcr, periodicity) are measured over this much audio after the onset. */
  featureSec: 0.06,

  /** A recording whose loudest moment is under this (dBFS RMS) is silence. */
  silenceDbfs: -80,

  // Onsets
  /** Adaptive threshold = median of the flux over ~95 ms × this + `fluxOffset`. */
  fluxMedianFactor: 1.5,
  /** Flux offset (mean log-magnitude rise per band, nepers). */
  fluxOffset: [0.2, 0.05],
  /** The level must rise this much (dB, valley → peak). Bands: full, < 300 Hz, > 3 kHz. */
  onsetRiseDb: [9, 3],
  /** A sub-band's rise counts when the band holds at least this share of the level (dB)… */
  subBandShareDb: -10,
  /**
   * …and must exceed the threshold by this much more (dB): the level of a narrow band of noise
   * wobbles (11 ms RMS below 300 Hz has ~6 degrees of freedom, above 3 kHz hundreds).
   */
  lowBandPenaltyDb: 12,
  highBandPenaltyDb: 6,
  /** Onset time: where the attack is this fraction (amplitude) of the way from the valley to the peak. */
  onsetFraction: 0.05,
  /** Gate: the peak level must be at least this far above the noise floor (dB)… */
  gateAboveNoiseDb: [20, 6],
  /** …and at most this far under the loudest moment of the recording (dB). */
  gateRangeDb: [30, 54],
  /** The noise floor estimate is capped this far under the loudest moment (dB). */
  noiseCapDb: 25,
  /**
   * Swells: a sound that takes longer than this (s) from its onset to half its peak level within
   * 400 ms, and whose periodicity is under `swellPeriodicity`, is a breath or similar noise swell
   * and is dropped. Drums get there in a few ms; a slowly swelling hum is periodic and stays.
   */
  swellAttackSec: 0.04,
  swellPeriodicity: 0.5,
  /** An onset inside a still-sustained tonal event needs a full-band rise of this much (dB), else it merges. */
  legatoRiseDb: 8,

  // Envelope measurements
  /** Decay = the level falls this far under the peak (dB)… */
  decayDb: 30,
  /** …or to this far over the noise floor (dB), whichever is higher. */
  decayAboveNoiseDb: 6,
  /** Sustain = time from the onset until the level falls this far under the peak (dB). */
  sustainDropDb: 15,

  // Tonal
  /** Minimum YIN periodicity over the first 60 ms. */
  tonalPeriodicity: 0.8,
  /** Minimum sustain (s). */
  tonalSustainSec: 0.12,
  /** Minimum fraction of confidently pitched frames over the sustained part. */
  tonalVoicedRatio: 0.6,
  /** Maximum energy fraction above 4 kHz (voices hum low; the pitch tracker can't see above 4 kHz). */
  tonalMaxHighRatio: 0.4,
  /** Maximum pitch change between the first 20 ms and 60–80 ms in (semitones): a kick sweeps down faster. */
  tonalMaxSweepSemitones: 5,
  /** A frame is confidently pitched at this YIN confidence (1 − aperiodicity). */
  pitchConfidence: 0.75,
  /** Pitch frames more than this far under the event's peak are ignored (dB). */
  pitchRangeDb: 25,
  /** Legato note change: the pitch moves more than this (semitones)… */
  splitSemitones: 1.5,
  /** …and stays there at least this long (s)… */
  splitHoldSec: 0.06,
  /** …within this of its median (semitones), drifting less than `stableDrift` across the hold. */
  stableSemitones: 0.35,
  stableDrift: 0.2,

  // Drums
  /** Kick: energy below 150 Hz at least this, or… */
  kickLowRatio: 0.3,
  /** …centroid under this (Hz). */
  kickCentroidHz: 400,
  /** Hat: energy above 4 kHz at least this, centroid over `hatCentroidHz` (Hz), shorter than `hatMaxSec`. */
  hatHighRatio: 0.65,
  hatCentroidHz: 5000,
  /** Longer bright sounds lean to snare (e.g. "psh"). */
  hatMaxSec: 0.15,
} as const;

/** A threshold that depends on `sensitivity`: `[value at 0, value at 1]`. */
export type SensitivityPair = readonly [number, number];

/** The value of a sensitivity pair for a sensitivity in 0..1 (linear between the two ends). */
export function bySensitivity(pair: SensitivityPair, sensitivity: number): number {
  return pair[0] + (pair[1] - pair[0]) * sensitivity;
}

/** Envelope block length (s): the finest time step of the level measurements. */
export const BLOCK_SEC = 0.001;
/** Hop between pitch-track frames (s). */
export const HOP_SEC = 0.005;
