/**
 * Pitch correction of a recorded clip (`AudioClip.pitchEdit`): what the edits mean, how they turn
 * into a pitch-shift curve, and the render. Pure functions of plain data (no DOM, no globals), so
 * the editor, the AI, the Worker and the tests all agree.
 *
 * Meaning of a note's edits, with c(t) the pitch as sung (cents), s(t) its slow line (a moving
 * average of 170 ms: glides and drift but no vibrato), v = c − s the vibrato, m the median of c:
 *
 *     target(t) = m + shift + (1 − drift)·(s − m) + vibrato·v
 *     shift at t = target(t) − c(t) = shift − drift·(s − m) + (vibrato − 1)·v
 *
 * so `shift` moves the whole note, `drift` flattens the slow wander towards the note's centre, and
 * `vibrato` scales the wobble (0 removes it). A note with no edits is not touched at all. The
 * curve between notes glides over `transition` ms; unvoiced sound is never shifted.
 */
import type { PitchEdit, PitchEditNote, SampleId } from '../model/types';
import {
  analyzePitch,
  framesToCents,
  PITCH_NOTE_THRESHOLDS,
  slowLine,
  trackVoicePitch,
  type PitchFrames,
  type PitchNote,
} from '../voice/pitch-notes';
import { psolaShift } from './psola';

/** Milliseconds of glide at note borders when the edit doesn't say. */
export const DEFAULT_TRANSITION_MS = 25;
export const MAX_TRANSITION_MS = 300;
/** Notes one clip's edit may hold (a guard against runaway data). */
export const MAX_PITCH_NOTES = 5000;
/** Largest move of a note, cents. */
export const MAX_SHIFT_CENTS = 1200;
/** Seconds either side of the edited notes that the render covers (so windows and glides have room). */
const RENDER_MARGIN = 0.3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

// ---- Reading an edit ----

export const noteShift = (n: PitchEditNote) => n.shift ?? 0;
export const noteDrift = (n: PitchEditNote) => n.drift ?? 0;
export const noteVibrato = (n: PitchEditNote) => n.vibrato ?? 1;
/** Where the note is going: a MIDI note (fractional). */
export const noteTarget = (n: PitchEditNote) => n.pitch + noteShift(n) / 100;

/** True when the note changes nothing. */
export function isNeutralNote(n: PitchEditNote): boolean {
  return Math.abs(noteShift(n)) < 0.005 && noteDrift(n) < 0.0005 && Math.abs(noteVibrato(n) - 1) < 0.0005;
}

/** True when the edit changes nothing (no render needed). */
export function isNeutralEdit(e: PitchEdit): boolean {
  return e.notes.every(isNeutralNote);
}

/**
 * A short string that changes whenever something the render depends on changes (notes, their
 * settings, the transition), to tell a stale render. Numbers are rounded to what they can mean.
 */
export function editSignature(e: PitchEdit): string {
  const parts: string[] = [`t${round(e.transition ?? DEFAULT_TRANSITION_MS, 1)}`];
  for (const n of e.notes) {
    if (isNeutralNote(n)) continue;
    parts.push(
      [round(n.from, 4), round(n.to, 4), round(noteShift(n), 2), round(noteDrift(n), 3), round(noteVibrato(n), 3)].join(','),
    );
  }
  return parts.join(';');
}

/** The seconds a render must cover: from the first to the last note that changes (plus a margin). */
export function renderRange(e: PitchEdit, duration: number): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const n of e.notes) {
    if (isNeutralNote(n)) continue;
    from = Math.min(from, n.from);
    to = Math.max(to, n.to);
  }
  if (!Number.isFinite(from)) return null;
  return { from: Math.max(0, from - RENDER_MARGIN), to: Math.min(duration, to + RENDER_MARGIN) };
}

// ---- Validation (loading a project, the AI) ----

/** A cleaned `PitchEdit` from unknown data, or null when it holds no usable notes. */
export function sanitizePitchEdit(v: unknown): PitchEdit | null {
  if (typeof v !== 'object' || v === null) return null;
  const raw = v as Record<string, unknown>;
  if (!Array.isArray(raw.notes)) return null;
  const notes: PitchEditNote[] = [];
  for (const item of raw.notes.slice(0, MAX_PITCH_NOTES)) {
    if (typeof item !== 'object' || item === null) continue;
    const n = item as Record<string, unknown>;
    if (!finite(n.from) || !finite(n.to) || !finite(n.pitch) || n.to <= n.from || n.from < 0) continue;
    const note: PitchEditNote = { from: n.from, to: n.to, pitch: clamp(n.pitch, 0, 127) };
    if (finite(n.shift) && n.shift !== 0) note.shift = clamp(n.shift, -MAX_SHIFT_CENTS, MAX_SHIFT_CENTS);
    if (finite(n.drift) && n.drift !== 0) note.drift = clamp(n.drift, 0, 1);
    if (finite(n.vibrato) && n.vibrato !== 1) note.vibrato = clamp(n.vibrato, 0, 2);
    notes.push(note);
  }
  if (notes.length === 0) return null;
  notes.sort((a, b) => a.from - b.from);
  // Not overlapping: a note starts where the previous one ends at the earliest.
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1] as PitchEditNote;
    const cur = notes[i] as PitchEditNote;
    if (cur.from < prev.to) cur.from = prev.to;
  }
  const out: PitchEdit = { notes: notes.filter((n) => n.to - n.from > 1e-4) };
  if (out.notes.length === 0) return null;
  if (finite(raw.transition) && raw.transition !== DEFAULT_TRANSITION_MS) out.transition = clamp(raw.transition, 0, MAX_TRANSITION_MS);
  if (typeof raw.renderedSampleId === 'string' && raw.renderedSampleId) {
    out.renderedSampleId = raw.renderedSampleId as SampleId;
    if (typeof raw.renderedFor === 'string') out.renderedFor = raw.renderedFor;
  }
  return out;
}

// ---- Making and changing edits (pure: each returns a new edit) ----

/** The edit that starts from the detected notes, with nothing changed. */
export function pitchEditFrom(notes: readonly PitchNote[]): PitchEdit {
  return {
    notes: notes.slice(0, MAX_PITCH_NOTES).map((n) => ({
      from: round(n.from, 4),
      to: round(n.to, 4),
      pitch: round(n.pitch, 3),
    })),
  };
}

/** `edit` with `change` applied to each note `which` picks (indices); empty settings are dropped. */
export function mapNotes(edit: PitchEdit, which: ReadonlySet<number> | 'all', change: (n: PitchEditNote, i: number) => PitchEditNote): PitchEdit {
  return { ...edit, notes: edit.notes.map((n, i) => (which === 'all' || which.has(i) ? tidyNote(change(n, i)) : n)) };
}

/** Drops fields at their neutral value (absent = default). */
export function tidyNote(n: PitchEditNote): PitchEditNote {
  const out: PitchEditNote = { from: n.from, to: n.to, pitch: n.pitch };
  if (n.shift !== undefined && Math.abs(n.shift) >= 0.005) out.shift = clamp(round(n.shift, 2), -MAX_SHIFT_CENTS, MAX_SHIFT_CENTS);
  if (n.drift !== undefined && n.drift >= 0.0005) out.drift = clamp(round(n.drift, 3), 0, 1);
  if (n.vibrato !== undefined && Math.abs(n.vibrato - 1) >= 0.0005) out.vibrato = clamp(round(n.vibrato, 3), 0, 2);
  return out;
}

/** Moves the note to a target (a MIDI note, fractional). */
export function withTarget(n: PitchEditNote, target: number): PitchEditNote {
  return { ...n, shift: clamp((target - n.pitch) * 100, -MAX_SHIFT_CENTS, MAX_SHIFT_CENTS) };
}

/**
 * The note of a scale nearest to a pitch (fractional MIDI): `allowed[pc]` says which pitch classes
 * (0 = C … 11 = B) count. Ties go down; no allowed class returns the pitch itself.
 */
export function nearestAllowed(pitch: number, allowed: readonly boolean[]): number {
  if (!allowed.some(Boolean)) return pitch;
  const centre = Math.round(pitch);
  let best = pitch;
  let bestDist = Infinity;
  for (let k = centre - 7; k <= centre + 7; k++) {
    if (!allowed[((k % 12) + 12) % 12]) continue;
    const d = Math.abs(pitch - k);
    if (d < bestDist - 1e-9) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

/**
 * Pulls notes to a key's scale: each note's target becomes the scale note nearest to where it was
 * sung, `strength` (0–1) of the way. Notes already settled by hand keep their edit when `keepEdited`.
 */
export function snapToKey(
  edit: PitchEdit,
  allowed: readonly boolean[],
  strength = 1,
  which: ReadonlySet<number> | 'all' = 'all',
): PitchEdit {
  const k = clamp(strength, 0, 1);
  return mapNotes(edit, which, (n) => withTarget(n, n.pitch + (nearestAllowed(n.pitch, allowed) - n.pitch) * k));
}

/** Cuts the note containing `t` (seconds) in two there; both halves keep the settings. Returns the edit as it was when `t` isn't inside a note. */
export function splitNote(edit: PitchEdit, t: number, frames?: PitchFrames): PitchEdit {
  const i = edit.notes.findIndex((n) => t > n.from + 0.02 && t < n.to - 0.02);
  if (i < 0) return edit;
  const n = edit.notes[i] as PitchEditNote;
  const a: PitchEditNote = { ...n, to: round(t, 4) };
  const b: PitchEditNote = { ...n, from: round(t, 4) };
  if (frames) {
    const pa = medianPitchOf(frames, a.from, a.to);
    const pb = medianPitchOf(frames, b.from, b.to);
    // The halves keep where the whole note was going (the target), whatever each half was sung at.
    const target = noteTarget(n);
    if (pa !== null) {
      a.pitch = round(pa, 3);
      a.shift = (target - a.pitch) * 100;
    }
    if (pb !== null) {
      b.pitch = round(pb, 3);
      b.shift = (target - b.pitch) * 100;
    }
  }
  const notes = edit.notes.slice();
  notes.splice(i, 1, tidyNote(a), tidyNote(b));
  return { ...edit, notes };
}

/** Joins notes `i` and the next one into one (the longer one's settings win). */
export function mergeNotes(edit: PitchEdit, i: number, frames?: PitchFrames): PitchEdit {
  const a = edit.notes[i];
  const b = edit.notes[i + 1];
  if (!a || !b) return edit;
  const lead = a.to - a.from >= b.to - b.from ? a : b;
  const merged: PitchEditNote = { ...lead, from: a.from, to: b.to };
  const p = frames ? medianPitchOf(frames, merged.from, merged.to) : null;
  if (p !== null) {
    merged.pitch = round(p, 3);
    merged.shift = (noteTarget(lead) - merged.pitch) * 100;
  } else {
    merged.pitch = (a.pitch * (a.to - a.from) + b.pitch * (b.to - b.from)) / (b.to - a.from);
    merged.shift = (noteTarget(lead) - merged.pitch) * 100;
  }
  const notes = edit.notes.slice();
  notes.splice(i, 2, tidyNote(merged));
  return { ...edit, notes };
}

/** One change to apply to notes of an edit (what the AI and the Pitch editor's buttons ask for). */
export type PitchAction =
  /** Pull to a key: `allowed` is the pitch classes of the scale, `strength` 0–1. */
  | { kind: 'snap'; allowed: readonly boolean[]; strength: number }
  /** Flatten slow drift, 0–1 (1 = dead straight). */
  | { kind: 'drift'; amount: number }
  /** Vibrato amount, 0–2 (1 = as sung, 0 = none). */
  | { kind: 'vibrato'; amount: number }
  /** Move by semitones, or to a pitch (MIDI, fractional). */
  | { kind: 'shift'; semitones: number }
  | { kind: 'to'; midi: number }
  /** Glide time in ms (the whole edit). */
  | { kind: 'transition'; ms: number }
  /** Back as sung. */
  | { kind: 'reset' };

/** The edit after an action, on the given notes (indices) or all of them. */
export function applyPitchAction(edit: PitchEdit, action: PitchAction, notes: ReadonlySet<number> | 'all' = 'all'): PitchEdit {
  switch (action.kind) {
    case 'snap':
      return snapToKey(edit, action.allowed, action.strength, notes);
    case 'drift':
      return mapNotes(edit, notes, (n) => ({ ...n, drift: clamp(action.amount, 0, 1) }));
    case 'vibrato':
      return mapNotes(edit, notes, (n) => ({ ...n, vibrato: clamp(action.amount, 0, 2) }));
    case 'shift':
      return mapNotes(edit, notes, (n) => withTarget(n, noteTarget(n) + action.semitones));
    case 'to':
      return mapNotes(edit, notes, (n) => withTarget(n, action.midi));
    case 'transition': {
      const next: PitchEdit = { ...edit, transition: clamp(action.ms, 0, MAX_TRANSITION_MS) };
      if (next.transition === DEFAULT_TRANSITION_MS) delete next.transition;
      return next;
    }
    case 'reset':
      return mapNotes(edit, notes, (n) => ({ from: n.from, to: n.to, pitch: n.pitch }));
  }
}

/** Median pitch (MIDI) of the voiced frames inside [from, to), or null when there are none. */
export function medianPitchOf(frames: PitchFrames, from: number, to: number): number | null {
  const { f0, hop, t0 } = frames;
  const v: number[] = [];
  const i0 = Math.max(0, Math.ceil((from - t0) / hop));
  const i1 = Math.min(f0.length - 1, Math.floor((to - t0) / hop));
  for (let i = i0; i <= i1; i++) if ((f0[i] as number) > 0) v.push(69 + 12 * Math.log2((f0[i] as number) / 440));
  if (v.length === 0) return null;
  v.sort((x, y) => x - y);
  return v[v.length >> 1] as number;
}

/** The note covering time `t` (seconds), or -1. */
export function noteIndexAt(edit: PitchEdit, t: number): number {
  return edit.notes.findIndex((n) => t >= n.from && t < n.to);
}

// ---- The shift curve ----

/**
 * The shift in cents per frame of `frames` that carries out the edit (see the file header). Zero
 * outside notes that change something; glides over the edit's transition time; unvoiced frames
 * inside a note follow their neighbours.
 */
export function shiftCurve(frames: PitchFrames, edit: PitchEdit): Float32Array {
  const { f0, hop, t0 } = frames;
  const n = f0.length;
  const cents = framesToCents(f0);
  const r = new Float64Array(n);
  const slowWin = Math.round(PITCH_NOTE_THRESHOLDS.slowSec / hop);
  for (const note of edit.notes) {
    if (isNeutralNote(note)) continue;
    const i0 = Math.max(0, Math.ceil((note.from - t0) / hop));
    const i1 = Math.min(n - 1, Math.ceil((note.to - t0) / hop) - 1);
    if (i1 < i0) continue;
    const voiced: number[] = [];
    for (let i = i0; i <= i1; i++) if (!Number.isNaN(cents[i] as number)) voiced.push(cents[i] as number);
    if (voiced.length === 0) continue;
    voiced.sort((a, b) => a - b);
    const med = voiced[voiced.length >> 1] as number;
    const slow = slowLine(cents, i0, i1, slowWin);
    const shift = noteShift(note);
    const drift = noteDrift(note);
    const vib = noteVibrato(note);
    let last = -1;
    for (let i = i0; i <= i1; i++) {
      const c = cents[i] as number;
      if (Number.isNaN(c)) continue;
      const s = slow[i - i0] as number;
      const value = shift - drift * (s - med) + (vib - 1) * (c - s);
      // Unvoiced frames since the last voiced one follow a line between the two.
      if (last >= 0 && i - last > 1) for (let k = last + 1; k < i; k++) r[k] = (r[last] as number) + (((value - (r[last] as number)) * (k - last)) / (i - last));
      else if (last < 0 && i > i0) for (let k = i0; k < i; k++) r[k] = value;
      r[i] = value;
      last = i;
    }
    if (last >= 0) for (let k = last + 1; k <= i1; k++) r[k] = r[last] as number;
  }
  // Glide: a triangular window of `transition` ms (two box filters), edges held.
  const transition = clamp(edit.transition ?? DEFAULT_TRANSITION_MS, 0, MAX_TRANSITION_MS);
  const width = Math.round(transition / 1000 / hop);
  let curve: Float64Array<ArrayBufferLike> = r;
  if (width >= 2) {
    const half = Math.max(1, Math.round(width / 4));
    curve = boxFilter(boxFilter(r, half), half);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clamp(curve[i] as number, -MAX_SHIFT_CENTS, MAX_SHIFT_CENTS);
  return out;
}

/** Moving average of ±`half` frames, edges held. */
function boxFilter(x: Float64Array, half: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (x[i] as number);
  const at = (i: number) => (i < 0 ? (x[0] as number) : i >= n ? (x[n - 1] as number) : 0);
  for (let i = 0; i < n; i++) {
    const lo = i - half;
    const hi = i + half;
    const a = Math.max(0, lo);
    const b = Math.min(n - 1, hi);
    let sum = (prefix[b + 1] as number) - (prefix[a] as number);
    if (lo < 0) sum += (-lo) * at(-1);
    if (hi > n - 1) sum += (hi - (n - 1)) * at(n);
    out[i] = sum / (2 * half + 1);
  }
  return out;
}

// ---- The render ----

export interface PitchRenderInput {
  /** The audio to correct: a stretch of the sample (planar). */
  channels: readonly Float32Array[];
  sampleRate: number;
  /** Seconds into the sample where `channels` begin. */
  start: number;
  edit: PitchEdit;
  onProgress?: (fraction: number) => void;
}

/**
 * Corrects the audio: tracks its pitch (YIN, cleaned), works out the shift curve of the edit and
 * runs TD-PSOLA. Returns new channels as long as the input; deterministic. `edit`'s notes are on
 * the sample's timeline; `start` is where `channels` begin on it.
 */
export function renderPitchEdit(input: PitchRenderInput): Float32Array[] {
  const { channels, sampleRate, start, edit } = input;
  const length = channels[0]?.length ?? 0;
  if (length === 0) return channels.map((c) => Float32Array.from(c));
  const mono = new Float32Array(length);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] = (mono[i] as number) + (ch[i] as number) * k;
  const hop = Math.max(1, Math.round(0.005 * sampleRate));
  // The same track the editor analysed (octave repair included), so the notes the edit names line up with the render.
  const voice = trackVoicePitch(mono, sampleRate, { minHz: 65, maxHz: 1100 });
  const frames: PitchFrames = { t0: start, hop: voice.hop, f0: voice.f0, conf: voice.conf };
  const shift = shiftCurve(frames, edit);
  return psolaShift(
    channels,
    sampleRate,
    { f0: voice.f0, shift, hop, t0: 0 },
    input.onProgress ? { onProgress: input.onProgress } : {},
  );
}

/** Mixes planar channels to mono over [from, to) samples. */
export function monoMix(channels: readonly Float32Array[], from = 0, to = channels[0]?.length ?? 0): Float32Array {
  const a = Math.max(0, from);
  const b = Math.min(channels[0]?.length ?? 0, to);
  const out = new Float32Array(Math.max(0, b - a));
  const k = 1 / Math.max(1, channels.length);
  for (const ch of channels) for (let i = a; i < b; i++) out[i - a] = (out[i - a] as number) + (ch[i] as number) * k;
  return out;
}

/** Analyses a stretch of a sample: `start` seconds is where `channels` begin on the sample's timeline. */
export function analyzeChannels(channels: readonly Float32Array[], sampleRate: number, start: number) {
  return analyzePitch(monoMix(channels), sampleRate, { start });
}
