/** The public shapes of the voice analysis, and the two internal records that flow between its steps. */

export type VoiceKind = 'kick' | 'snare' | 'hat' | 'tonal';

export interface VoiceFeatures {
  /** Spectral centroid in Hz (power-weighted) over the first 60 ms. */
  centroid: number;
  /** Fraction of the energy below 150 Hz. */
  lowRatio: number;
  /** Fraction of the energy above 4 kHz. */
  highRatio: number;
  /** Zero crossings per second. */
  zcr: number;
  /** YIN periodicity 0..1 (1 − CMND minimum: ≈ 1 for a clean tone, low for noise). */
  periodicity: number;
}

export interface VoiceEvent {
  /** Seconds from the start of the audio (the onset). */
  time: number;
  /** Seconds until it decays (−30 dB from its peak) or the next onset. */
  duration: number;
  /** 0..1, peak level relative to the loudest event (linear amplitude). */
  strength: number;
  kind: VoiceKind;
  /** 0..1 how sure the classification is. */
  confidence: number;
  /** Tonal: median MIDI pitch (fractional) of the confident frames; otherwise null. */
  pitch: number | null;
  /** Tonal: MIDI pitch near the end (for slides/glides); otherwise null. */
  pitchEnd: number | null;
  features: VoiceFeatures;
}

/** Which kinds of sound the analysis may report. */
export type VoiceMode = 'auto' | 'drums' | 'tonal';

export interface AnalyzeOptions {
  /** 0..1, default 0.5. Higher finds quieter and softer onsets (and more false ones). */
  sensitivity?: number;
  /** Onsets closer than this collapse into one (default 0.05 s). */
  minGapSec?: number;
  /** 'drums' never returns tonal; 'tonal' makes every event tonal (with pitch where detectable). */
  mode?: VoiceMode;
}

/** One detected attack, before it is measured. */
export interface Onset {
  /** Seconds. */
  time: number;
  /** Flux peak value (for choosing between close onsets). */
  flux: number;
  /** Rise in the band that rose most (dB). */
  riseDb: number;
  /** Rise of the full-band level (dB). */
  fullRiseDb: number;
  /** A legato note change found in the pitch track (no attack: no background subtraction). */
  split?: boolean;
}

/** An onset with everything measured about the sound that follows it. */
export interface Measured {
  onset: Onset;
  /** Previous onset (s), −Infinity for the first. */
  prev: number;
  /** Span end: next onset or end of audio (s). */
  end: number;
  peak: number;
  /** Seconds. */
  duration: number;
  sustainSec: number;
  features: VoiceFeatures;
  kind: VoiceKind;
  confidence: number;
}
