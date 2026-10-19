import { median, sigmoid } from './math';
import type { PitchFrames } from './pitch-frames';
import { VOICE_THRESHOLDS } from './thresholds';
import type { Measured, VoiceFeatures, VoiceMode } from './types';

const T = VOICE_THRESHOLDS;

/**
 * How soft each score's threshold is. Each score is `sigmoid((value − threshold) / width)`, so one
 * width (in the score's own unit) either side of the threshold the score is 27 % or 73 %.
 */
const WIDTH = {
  periodicity: 0.04,
  sustainSec: 0.02,
  highRatio: 0.08,
  voicedRatio: 0.08,
  sweepSemitones: 0.5,
  kickLowRatio: 0.08,
  kickCentroidOctaves: 0.4,
  hatHighRatio: 0.1,
  hatCentroidOctaves: 0.35,
  hatLengthSec: 0.04,
} as const;

/** A tonal score above this means the event is a hum, not a drum. */
const TONAL_ACCEPT = 0.5;
/** The pitch track is only worth computing when every cheap tonal score is above this. */
const WORTH_CHECKING_PITCH = 0.1;
/** The pitch track of an event covers its sustain (at least 30 ms, at most 400 ms). */
const MIN_PITCH_SPAN_SEC = 0.03;
const MAX_PITCH_SPAN_SEC = 0.4;
/** A kick's pitch drop is read as the median of frames [0, 4) against frames [12, 17) of its pitch track (~5 ms each). */
const SWEEP_EARLY_FRAMES: readonly [number, number] = [0, 4];
const SWEEP_LATE_FRAMES: readonly [number, number] = [12, 17];

/** The best-scoring drum for a sound, and how clear the win was. */
interface DrumGuess {
  kind: 'kick' | 'snare' | 'hat';
  confidence: number;
}

/** Kick / snare / hat from soft scores; confidence = the winner's share of the three scores. */
export function drumScores(f: VoiceFeatures, duration: number): DrumGuess {
  const logCentroid = Math.log2(Math.max(f.centroid, 1));
  const kick = Math.max(
    sigmoid((f.lowRatio - T.kickLowRatio) / WIDTH.kickLowRatio),
    sigmoid((Math.log2(T.kickCentroidHz) - logCentroid) / WIDTH.kickCentroidOctaves),
  );
  const hat =
    (2 * sigmoid((f.highRatio - T.hatHighRatio) / WIDTH.hatHighRatio) +
      2 * sigmoid((logCentroid - Math.log2(T.hatCentroidHz)) / WIDTH.hatCentroidOctaves) +
      sigmoid((T.hatMaxSec - duration) / WIDTH.hatLengthSec)) /
    5;
  const snare = 1 - Math.max(kick, hat);
  const sum = kick + hat + snare;
  if (kick >= hat && kick >= snare) return { kind: 'kick', confidence: kick / sum };
  if (hat >= snare) return { kind: 'hat', confidence: hat / sum };
  return { kind: 'snare', confidence: snare / sum };
}

/**
 * Sets the kind and confidence of a measured event. Tonal needs periodicity, sustain, confidently
 * pitched frames, little energy above 4 kHz and no kick-like pitch drop at the start; otherwise
 * the drum scores decide. `mode` 'drums' skips the tonal test, 'tonal' skips the drum test.
 */
export function classifyEvent(event: Measured, mode: VoiceMode, pitch: PitchFrames): void {
  const features = event.features;
  const drums = drumScores(features, event.duration);
  if (mode === 'drums') {
    event.kind = drums.kind;
    event.confidence = drums.confidence;
    return;
  }
  // Periodicity and sustain first: only then is the pitch track over the sustain worth computing.
  const periodic = sigmoid((features.periodicity - T.tonalPeriodicity) / WIDTH.periodicity);
  const sustained = sigmoid((event.sustainSec - T.tonalSustainSec) / WIDTH.sustainSec);
  // YIN runs below 4 kHz: a sound that lives above it (a hat over a kick's tail) can't be judged by it.
  const dark = sigmoid((T.tonalMaxHighRatio - features.highRatio) / WIDTH.highRatio);
  let voiced = 0;
  let steady = 1;
  const worthCheckingPitch =
    periodic > WORTH_CHECKING_PITCH && sustained > WORTH_CHECKING_PITCH && dark > WORTH_CHECKING_PITCH;
  if (mode === 'tonal' || worthCheckingPitch) {
    const evidence = pitchEvidence(event, pitch);
    voiced = evidence.voiced;
    steady = evidence.steady;
  }
  const tonal = Math.min(periodic, sustained, dark, voiced, steady);
  if (mode === 'tonal' || tonal >= TONAL_ACCEPT) {
    event.kind = 'tonal';
    event.confidence = tonal;
  } else {
    event.kind = drums.kind;
    event.confidence = drums.confidence * (1 - tonal);
  }
}

/** Scores from the pitch track: how much of the sustain is confidently pitched, and how steady the pitch starts. */
function pitchEvidence(event: Measured, pitch: PitchFrames): { voiced: number; steady: number } {
  const startSec = event.onset.time;
  const endSec = Math.min(
    event.end,
    startSec + Math.max(event.sustainSec, MIN_PITCH_SPAN_SEC),
    startSec + MAX_PITCH_SPAN_SEC,
  );
  const { midi } = pitch.midiTrack(startSec, endSec, event.peak);
  let pitchedFrames = 0;
  for (let i = 0; i < midi.length; i++) if (!Number.isNaN(midi[i] as number)) pitchedFrames++;
  const voiced = sigmoid((pitchedFrames / Math.max(1, midi.length) - T.tonalVoicedRatio) / WIDTH.voicedRatio);
  // A kick's pitch falls fast (a clipped kick also sustains, so this is what tells it from a hum).
  const medianOf = ([from, to]: readonly [number, number]) =>
    median(Array.from(midi.subarray(from, to)).filter((v) => !Number.isNaN(v)));
  const early = medianOf(SWEEP_EARLY_FRAMES);
  const late = medianOf(SWEEP_LATE_FRAMES);
  if (!Number.isFinite(early) || !Number.isFinite(late)) return { voiced, steady: 1 };
  return { voiced, steady: sigmoid((T.tonalMaxSweepSemitones - Math.abs(late - early)) / WIDTH.sweepSemitones) };
}
