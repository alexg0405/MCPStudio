/**
 * Renders one harmony voice from a lead: its notes shifted by TD-PSOLA to the planned pitches (formants kept, or moved a little
 * for a different singer), each note with its own humanize drift and vibrato, then arranged in time (`arrange.ts`).
 * Pure and deterministic, so the render is bit-identical every time and runs in a Worker or in Node.
 */
import { renderPitchEdit } from '../../audio/pitch-edit';
import type { PitchEdit, PitchEditNote } from '../../model/types';
import { arrangeVoice, type VoicePart } from './arrange';
import type { NoteHumanize } from './humanize';

/** The cents a voice at least moves by: keeps every harmony note on the same render path (its formants and character) even for a unison. */
const MIN_SHIFT_CENTS = 0.05;
/** The largest shift the shifter takes either way, cents. */
const MAX_SHIFT_CENTS = 1200;
/** Largest formant move, cents. */
export const MAX_FORMANT_CENTS = 300;

/** A note of the lead as the sample holds it (the pitch it was sung at, seconds on the sample's timeline). */
export interface SourceNote {
  from: number;
  to: number;
  /** MIDI pitch as sung in the sample (fractional). */
  pitch: number;
}

/** What one voice's render needs. */
export interface VoiceRenderInput {
  /** The lead's sound for a stretch of the sample, planar. */
  channels: readonly Float32Array[];
  sampleRate: number;
  /** Seconds into the sample where `channels` begin. */
  start: number;
  /** The lead's notes (sample time). */
  notes: readonly SourceNote[];
  /** Where each note goes, as the semitones to move it from how it was sung; null = the voice is silent there. */
  shifts: readonly (number | null)[];
  /** Per note: timing, pitch drift and vibrato differences. */
  humanize: readonly NoteHumanize[];
  /** Moves the formants (cents); 0 keeps the lead's. */
  formantCents: number;
  onProgress?: (fraction: number) => void;
}

/** The pitch edit that carries the plan out (silent notes are left alone: they are muted afterwards). */
export function voiceEdit(input: Pick<VoiceRenderInput, 'notes' | 'shifts' | 'humanize'>): PitchEdit {
  const notes: PitchEditNote[] = input.notes.map((n, i) => {
    const semitones = input.shifts[i] ?? 0;
    const h = input.humanize[i];
    const cents = Math.max(-MAX_SHIFT_CENTS, Math.min(MAX_SHIFT_CENTS, semitones * 100 + (h?.driftCents ?? 0)));
    const shift = Math.abs(cents) < MIN_SHIFT_CENTS ? MIN_SHIFT_CENTS : cents;
    return { from: n.from, to: n.to, pitch: n.pitch, shift, vibrato: Math.max(0, Math.min(2, h?.vibratoScale ?? 1)) };
  });
  return { notes };
}

/** The parts the arrangement places: each note with its humanize delay and whether the voice is silent there. */
export function voiceParts(input: Pick<VoiceRenderInput, 'notes' | 'shifts' | 'humanize'>): VoicePart[] {
  return input.notes.map((n, i) => ({
    from: n.from,
    to: n.to,
    delaySec: input.humanize[i]?.delaySec ?? 0,
    silent: input.shifts[i] === null,
  }));
}

/** Renders a voice: the shifted lead, arranged. As long as the input; deterministic. */
export function renderHarmonyVoice(input: VoiceRenderInput): Float32Array[] {
  const formantRatio = Math.pow(2, Math.max(-MAX_FORMANT_CENTS, Math.min(MAX_FORMANT_CENTS, input.formantCents)) / 1200);
  const shifted = renderPitchEdit({
    channels: input.channels,
    sampleRate: input.sampleRate,
    start: input.start,
    edit: voiceEdit(input),
    formantRatio,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  return arrangeVoice(shifted, input.sampleRate, input.start, voiceParts(input));
}
