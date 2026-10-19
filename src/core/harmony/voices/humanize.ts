/**
 * The small differences between harmony voices: each voice gets its own seeded take, so a stack of voices does not sound like
 * one voice played several times (identical copies phase and thin out), and making a voice again gives the same take.
 */
import { hashString, jitter, mulberry32 } from '../../arrange/random';
import type { HarmonyHumanize } from '../../model/types';

/** Defaults: noticeable as a group, never as a mistake. */
export const DEFAULT_HUMANIZE: HarmonyHumanize = { timingMs: 12, driftCents: 6, vibrato: 0.3 };

/** The largest values the settings take. */
export const HUMANIZE_LIMITS = { timingMs: 40, driftCents: 40, vibrato: 1 } as const;

/** What one voice does differently on one note. */
export interface NoteHumanize {
  /** Seconds the note starts early (negative) or late (positive); never more than the timing setting. */
  delaySec: number;
  /** Cents the note's pitch is off. */
  driftCents: number;
  /** Multiplies the lead's vibrato on this note (1 = as sung). */
  vibratoScale: number;
}

/** The humanize settings held to their limits. */
export function clampHumanize(h: HarmonyHumanize): HarmonyHumanize {
  const within = (v: number, max: number) => (Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);
  return {
    timingMs: within(h.timingMs, HUMANIZE_LIMITS.timingMs),
    driftCents: within(h.driftCents, HUMANIZE_LIMITS.driftCents),
    vibrato: within(h.vibrato, HUMANIZE_LIMITS.vibrato),
  };
}

/** The seed of voice number `voice` of a group made with `seed`. */
export function voiceSeed(group: string, voice: number, seed: number): number {
  return (hashString(group) ^ Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(voice + 1, 0x85ebca6b)) >>> 0;
}

/** The humanize numbers for `count` notes of one voice. Deterministic in the seed. */
export function humanizeNotes(count: number, settings: HarmonyHumanize, seed: number): NoteHumanize[] {
  const h = clampHumanize(settings);
  const rand = mulberry32(seed);
  const notes: NoteHumanize[] = [];
  for (let i = 0; i < count; i++) {
    notes.push({
      delaySec: jitter(rand, h.timingMs / 1000),
      driftCents: jitter(rand, h.driftCents),
      vibratoScale: 1 + jitter(rand, h.vibrato),
    });
  }
  return notes;
}
