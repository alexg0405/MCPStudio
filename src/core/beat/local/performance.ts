import type { BeatNote } from '../spec';
import { snapToScale } from './bass';
import type { PerformanceRole, PerformedEvent, PromptInfo } from './types';

/**
 * Moves hummed pitches into a register, keeping their shape (and the key, when one was asked for).
 * Unpitched events get the fallback key.
 */
function placePitches(
  events: readonly PerformedEvent[],
  targetCenter: number,
  key: PromptInfo['key'],
  fallback: number,
): number[] {
  const pitched = events.filter((e) => e.pitch !== null).map((e) => e.pitch as number);
  if (pitched.length === 0) return events.map(() => fallback);
  const sorted = [...pitched].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  let shift = Math.round((targetCenter - median) / 12) * 12;
  if (key) {
    const tonic = mostHeldPitchClass(events);
    let toKey = key.root - tonic;
    if (toKey > 6) toKey -= 12;
    if (toKey < -6) toKey += 12;
    shift = Math.round((targetCenter - (median + toKey)) / 12) * 12 + toKey;
  }
  return events.map((e) => {
    if (e.pitch === null) return fallback;
    const k = Math.round(e.pitch + shift);
    return key ? snapToScale(k, key.root, key.minor) : k;
  });
}

/** The pitch class (0–11) the performance holds longest: it becomes the key's root. */
function mostHeldPitchClass(events: readonly PerformedEvent[]): number {
  const weight = new Array<number>(12).fill(0);
  events.forEach((e) => {
    if (e.pitch === null) return;
    const pc = ((Math.round(e.pitch) % 12) + 12) % 12;
    weight[pc] = (weight[pc] ?? 0) + e.lengthSteps;
  });
  return weight.indexOf(Math.max(...weight));
}

/** The performance as notes for an 808 (or melody) track; connected notes overlap so they glide. */
export function tonalNotes(
  events: readonly PerformedEvent[],
  center: number,
  key: PromptInfo['key'],
  fallback: number,
  total: number,
  glide: boolean,
): BeatNote[] {
  const sorted = [...events].sort((a, b) => a.step - b.step);
  const keys = placePitches(sorted, center, key, fallback);
  const notes: BeatNote[] = [];
  sorted.forEach((e, i) => {
    const next = sorted[i + 1];
    let len = Math.max(0.5, e.lengthSteps);
    if (next && glide && next.step - (e.step + len) <= 0.5 && keys[i + 1] !== keys[i]) len = next.step - e.step + 0.5;
    if (next && !glide) len = Math.min(len, next.step - e.step);
    len = Math.min(len, total - e.step);
    notes.push({ step: e.step, len, key: keys[i], vel: Math.max(0.4, Math.min(1, 0.5 + e.strength / 2)) });
    if (glide && e.pitchEnd !== null && e.pitch !== null && Math.abs(e.pitchEnd - e.pitch) >= 1 && len >= 1.5) {
      // A slide within one hummed note: a second, overlapping note at the end pitch.
      const end = (keys[i] as number) + Math.round(e.pitchEnd - e.pitch);
      notes.push({ step: e.step + len / 2, len: len / 2, key: end, vel: 0.8 });
    }
  });
  return notes;
}

/** What the performance stands for: the asked-for role, or drums unless most of it is hummed (then 808, or melody when asked for). */
export function decideRole(
  role: PerformanceRole,
  events: readonly PerformedEvent[],
  info: PromptInfo,
): Exclude<PerformanceRole, 'auto'> {
  if (role !== 'auto') return role;
  const tonal = events.filter((e) => e.kind === 'tonal').length;
  if (tonal >= events.length / 2 && tonal > 0) return info.wantsMelody && !info.wants808 ? 'melody' : '808';
  return 'drums';
}
