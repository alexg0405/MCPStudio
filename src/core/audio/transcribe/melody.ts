/**
 * Melody: the notes of one voice or one instrument played alone. The pitch track and note segmentation are the sung-note
 * analysis the pitch editor uses (`analyzePitch`: YIN, cleaning, octave repair, cut where the pitch settles on a new level),
 * with repeated notes split where the level dips and a loudness for each note. Pure and deterministic.
 */
import { analyzePitch } from '../../voice/pitch-notes';
import { heardNotesFrom } from './notes-heard';
import type { HeardNote } from './types';

/** Settings of the melody listener. */
export interface MelodyOptions {
  /** 0..1: how much is picked up (default 0.5). */
  sensitivity?: number;
}

/** The notes sung or played in a mono recording (voices from 65 Hz to 1100 Hz), seconds on the recording's timeline. */
export function detectMelody(mono: Float32Array, sampleRate: number, options: MelodyOptions = {}): HeardNote[] {
  const analysis = analyzePitch(mono, sampleRate);
  return heardNotesFrom(analysis.notes, mono, sampleRate, options.sensitivity ?? 0.5);
}
