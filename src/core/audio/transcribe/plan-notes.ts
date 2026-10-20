/**
 * Planning the notes of a melody or a bassline: the heard notes get their ends shaped (legato, natural, staccato), land
 * in song ticks through the clip's own playback maths (trim, tempo follow, pitch), snap to the grid and become keys and
 * velocities. Pure.
 */
import { clipEndTick, heardShiftSemitones, songTickAt, type ClipTimeline } from './timeline';
import { makeQuantizer, measureSwing, type Quantizer } from './quantize';
import type { HeardNote, PlannedNote, TranscribeSettings } from './types';

/** Staccato plays this share of each note's heard length. */
const STACCATO_SHARE = 0.5;
/** The shortest note written (ticks), whatever the grid. */
const MIN_NOTE_TICKS = 30;
/** Lowest velocity written: a quiet note is still a note. */
const MIN_VELOCITY = 0.2;
/** A note that began before the clip is kept when at least this much of it plays inside (ticks). */
const MIN_CARRIED_TICKS = 120;

/** The notes with their ends shaped by the articulation (seconds). */
export function shapeEnds(notes: readonly HeardNote[], settings: Pick<TranscribeSettings, 'articulation' | 'legatoGapMs'>): HeardNote[] {
  const sorted = [...notes].sort((a, b) => a.fromSec - b.fromSec);
  return sorted.map((note, i) => {
    if (settings.articulation === 'staccato') return { ...note, toSec: note.fromSec + (note.toSec - note.fromSec) * STACCATO_SHARE };
    const next = sorted[i + 1];
    const gapSec = next ? next.fromSec - note.toSec : Infinity;
    if (settings.articulation === 'legato' && next && gapSec <= settings.legatoGapMs / 1000) return { ...note, toSec: next.fromSec };
    return note;
  });
}

/** A heard note in the clip's own ticks (from the clip's start), before quantizing; null when it is outside the clip. */
interface TimedNote {
  from: number;
  to: number;
  note: HeardNote;
}

function timed(notes: readonly HeardNote[], timeline: ClipTimeline): TimedNote[] {
  const start = timeline.clip.start;
  const length = timeline.clip.length;
  const out: TimedNote[] = [];
  for (const note of notes) {
    const from = songTickAt(timeline, note.fromSec) - start;
    const to = songTickAt(timeline, note.toSec) - start;
    if (from >= length || to <= 0) continue;
    if (from < 0 && to < MIN_CARRIED_TICKS) continue;
    out.push({ from: Math.max(0, from), to: Math.min(length, to), note });
  }
  return out;
}

/** The key and fine cents a heard pitch is written as. */
function keyOf(pitch: number, keepCents: boolean): { key: number; fine?: number } {
  const key = Math.max(0, Math.min(127, Math.round(pitch)));
  if (!keepCents) return { key };
  const cents = Math.round((pitch - key) * 100);
  return cents === 0 ? { key } : { key, fine: Math.max(-100, Math.min(100, cents)) };
}

/** One timed note as a planned note (quantized start and end, key, velocity). */
function planned(item: TimedNote, quantize: Quantizer, timeline: ClipTimeline, settings: TranscribeSettings, minLength: number): PlannedNote {
  const absoluteStart = timeline.clip.start + item.from;
  const shift = heardShiftSemitones(timeline, absoluteStart);
  const tick = Math.max(0, quantize(item.from));
  const end = Math.max(tick + minLength, quantize(item.to));
  const { key, fine } = keyOf(item.note.pitch + shift, settings.keepCents);
  return {
    tick,
    length: Math.max(1, Math.min(timeline.clip.length - tick, end - tick)),
    key,
    velocity: Math.round(Math.max(MIN_VELOCITY, Math.min(1, item.note.level)) * 1000) / 1000,
    ...(fine !== undefined ? { fine } : {}),
  };
}

/** Notes of one voice never overlap: a note ends where the next one starts. */
function untangle(notes: PlannedNote[]): PlannedNote[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || b.velocity - a.velocity);
  const out: PlannedNote[] = [];
  for (const note of sorted) {
    const last = out[out.length - 1];
    if (last && last.tick === note.tick) continue;
    if (last && last.tick + last.length > note.tick) last.length = Math.max(1, note.tick - last.tick);
    out.push({ ...note });
  }
  return out;
}

/** What planning a line of notes gives: the notes and the recording's swing, when measurable. */
export interface PlannedLine {
  notes: PlannedNote[];
  swingFound: number | null;
}

/** Plans the notes of a melody or a bassline for a clip. */
export function planNoteLine(heard: readonly HeardNote[], timeline: ClipTimeline, settings: TranscribeSettings): PlannedLine {
  const items = timed(shapeEnds(heard, settings), timeline);
  const swingFound = measureSwing(items.map((item) => item.from));
  const quantize = makeQuantizer(settings.quantize, { songSwing: timeline.songSwing, swingFound, clipStart: timeline.clip.start });
  const grid = settings.quantize.gridTicks;
  const minLength = Math.max(MIN_NOTE_TICKS, grid > 1 ? grid / 2 : 0);
  const notes = untangle(items.map((item) => planned(item, quantize, timeline, settings, minLength)));
  return { notes: notes.filter((n) => n.tick < clipEndTick(timeline) - timeline.clip.start), swingFound };
}
