/**
 * Carrying a pitch edit out: how its notes turn into a pitch-shift curve, and the render (pitch tracking, the curve,
 * TD-PSOLA). Pure functions of plain data (no DOM, no globals), so the editor, the AI, the Worker and the tests
 * all agree.
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
import type { PitchEdit, PitchEditNote } from '../../model/types';
import {
  analyzePitch,
  framesToCents,
  PITCH_NOTE_THRESHOLDS,
  slowLine,
  trackVoicePitch,
  type PitchFrames,
} from '../../voice/pitch-notes';
import { psolaShift } from '../psola';
import {
  DEFAULT_TRANSITION_MS,
  MAX_SHIFT_CENTS,
  MAX_TRANSITION_MS,
  isNeutralNote,
  noteDrift,
  noteShift,
  noteVibrato,
} from './edit';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- The shift curve ----

/**
 * The shift in cents per frame of `frames` that carries out the edit (see the file header). Zero
 * outside notes that change something; glides over the edit's transition time; unvoiced frames
 * inside a note follow their neighbours.
 */
export function shiftCurve(frames: PitchFrames, edit: PitchEdit): Float32Array {
  const { f0, hop } = frames;
  const n = f0.length;
  const cents = framesToCents(f0);
  const r = new Float64Array(n);
  for (const note of edit.notes) {
    if (!isNeutralNote(note)) addNoteShift(r, cents, frames, note);
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

/**
 * Writes one note's shift (cents, see the header formula) into `shift` over the note's frames: voiced frames get the
 * formula's value; unvoiced frames inside the note follow a line between their voiced neighbours (or hold the nearest).
 */
function addNoteShift(shift: Float64Array, cents: Float64Array, frames: PitchFrames, note: PitchEditNote): void {
  const { hop, t0 } = frames;
  const n = cents.length;
  const i0 = Math.max(0, Math.ceil((note.from - t0) / hop));
  const i1 = Math.min(n - 1, Math.ceil((note.to - t0) / hop) - 1);
  if (i1 < i0) return;
  const voiced: number[] = [];
  for (let i = i0; i <= i1; i++) if (!Number.isNaN(cents[i] as number)) voiced.push(cents[i] as number);
  if (voiced.length === 0) return;
  voiced.sort((a, b) => a - b);
  const median = voiced[voiced.length >> 1] as number;
  const slow = slowLine(cents, i0, i1, Math.round(PITCH_NOTE_THRESHOLDS.slowSec / hop));
  const move = noteShift(note);
  const drift = noteDrift(note);
  const vibrato = noteVibrato(note);
  let last = -1;
  for (let i = i0; i <= i1; i++) {
    const c = cents[i] as number;
    if (Number.isNaN(c)) continue;
    const s = slow[i - i0] as number;
    const value = move - drift * (s - median) + (vibrato - 1) * (c - s);
    // Unvoiced frames since the last voiced one follow a line between the two.
    if (last >= 0 && i - last > 1) {
      const from = shift[last] as number;
      for (let k = last + 1; k < i; k++) shift[k] = from + ((value - from) * (k - last)) / (i - last);
    } else if (last < 0 && i > i0) {
      for (let k = i0; k < i; k++) shift[k] = value;
    }
    shift[i] = value;
    last = i;
  }
  if (last >= 0) for (let k = last + 1; k <= i1; k++) shift[k] = shift[last] as number;
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
    if (lo < 0) sum += -lo * at(-1);
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
