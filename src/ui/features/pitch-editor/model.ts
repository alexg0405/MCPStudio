/**
 * Pure helpers of the Pitch editor: how notes, targets and pointer positions relate. The editor's
 * "ticks" are milliseconds on the clip's sample timeline and its rows are MIDI notes (row 0 = 127),
 * like the piano roll's. No DOM here, so it is unit-tested.
 */
import { nearestAllowed, noteTarget, shiftCurve } from '@core/audio/pitch-edit';
import type { PitchEdit, PitchEditNote } from '@core/model/types';
import type { PitchFrames } from '@core/voice/pitch-notes';

export const keyForRow = (row: number) => 127 - row;
export const rowForKey = (key: number) => 127 - key;

/** A note as drawn: where it was sung, where it is going, and whether it differs. */
export interface DrawNote {
  index: number;
  fromMs: number;
  toMs: number;
  /** MIDI (fractional) as sung and as targeted. */
  sung: number;
  target: number;
  edited: boolean;
  drift: number;
  vibrato: number;
}

export function drawNotes(edit: PitchEdit, moveSemitones = 0, moving: ReadonlySet<number> | null = null): DrawNote[] {
  return edit.notes.map((n: PitchEditNote, index) => {
    const target = noteTarget(n) + (moving?.has(index) ? moveSemitones : 0);
    const shifted = Math.abs(target - n.pitch) > 0.0005;
    return {
      index,
      fromMs: n.from * 1000,
      toMs: n.to * 1000,
      sung: n.pitch,
      target,
      edited: shifted || (n.drift ?? 0) > 0.0005 || Math.abs((n.vibrato ?? 1) - 1) > 0.0005,
      drift: n.drift ?? 0,
      vibrato: n.vibrato ?? 1,
    };
  });
}

/**
 * The note under a pointer: `ms` along the timeline, `pitch` the (fractional) MIDI value at the
 * pointer's height. A blob is a band of ±0.5 semitone around its target; the nearest wins, and
 * when none is hit a note whose time span holds the pointer and whose target is within a
 * semitone and a half counts (blobs are thin when zoomed out).
 */
export function hitNote(notes: readonly DrawNote[], ms: number, pitch: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const n of notes) {
    if (ms < n.fromMs || ms > n.toMs) continue;
    const d = Math.abs(pitch - n.target);
    if (d < bestDist) {
      bestDist = d;
      best = n.index;
    }
  }
  return bestDist <= 1.5 ? best : -1;
}

/** Notes whose blob touches the rectangle (ms range, pitch range). */
export function notesInRect(notes: readonly DrawNote[], ms0: number, ms1: number, pitchLo: number, pitchHi: number): number[] {
  const out: number[] = [];
  for (const n of notes) {
    if (n.toMs < ms0 || n.fromMs > ms1) continue;
    if (n.target + 0.5 < pitchLo || n.target - 0.5 > pitchHi) continue;
    out.push(n.index);
  }
  return out;
}

/**
 * Where a drag puts the grabbed note: `anchor` is its target when the drag began, `delta` the
 * pointer's height change in semitones. Snaps to whole semitones (to the key's notes when a mask is
 * given); Alt moves freely, to the cent.
 */
export function dragTarget(anchor: number, delta: number, opts: { free: boolean; mask?: readonly boolean[] | null }): number {
  const raw = anchor + delta;
  if (opts.free) return Math.round(raw * 100) / 100;
  if (opts.mask && opts.mask.some(Boolean)) return nearestAllowed(raw, opts.mask);
  return Math.round(raw);
}

/** The pitch curve (MIDI, NaN where unvoiced) of frames, optionally moved by an edit's shift curve. */
export function curveMidi(frames: PitchFrames, edit: PitchEdit | null): Float32Array {
  const out = new Float32Array(frames.f0.length);
  const shift = edit ? shiftCurve(frames, edit) : null;
  for (let i = 0; i < out.length; i++) {
    const f = frames.f0[i] as number;
    out[i] = f > 0 ? 69 + 12 * Math.log2(f / 440) + (shift ? (shift[i] as number) / 100 : 0) : Number.NaN;
  }
  return out;
}

/** "C4 +23 ct": a pitch as note name and cents off it (`name` is the app's note naming). */
export function pitchText(midi: number, name: (key: number) => string): string {
  const near = Math.round(midi);
  const cents = Math.round((midi - near) * 100);
  return cents === 0 ? name(near) : `${name(near)} ${cents > 0 ? '+' : '−'}${Math.abs(cents)} ct`;
}

/** Seconds as "m:ss.s" for the ruler and readouts. */
export function clockText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
