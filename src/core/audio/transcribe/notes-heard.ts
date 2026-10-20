/**
 * From a pitch track's notes to `HeardNote`s: repeated notes split at level dips, a loudness for each note, and the
 * notes that are too short or too quiet left out (how much is the sensitivity). Shared by the melody and the bass paths.
 * Pure.
 */
import type { PitchNote } from '../../voice/pitch-notes';
import { DEFAULT_DIP_DB, levelCurveDb, noteLevelDb, percentile, splitPointsAtDips } from './levels';
import type { HeardNote } from './types';

/** The shortest note kept at sensitivity 0 and 1 (s). */
const MIN_NOTE_SEC = [0.12, 0.04] as const;
/** How far under the loudest notes a note may be and still count, at sensitivity 0 and 1 (dB). */
const FLOOR_DB = [24, 48] as const;
/** The loudness the notes are measured against: this share of the way up the sorted note levels. */
const TOP_SHARE = 0.95;

const lerp = (pair: readonly [number, number], t: number) => pair[0] + (pair[1] - pair[0]) * t;

/** A pitch note cut into pieces at the level dips inside it. */
function pieces(note: PitchNote, curve: Float32Array, dipDb: number): { from: number; to: number; pitch: number }[] {
  const cuts = splitPointsAtDips(curve, note.from, note.to, dipDb);
  const edges = [note.from, ...cuts, note.to];
  const out: { from: number; to: number; pitch: number }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push({ from: edges[i] as number, to: edges[i + 1] as number, pitch: note.pitch });
  return out;
}

/**
 * Heard notes from the pitch track's notes: `mono` is the signal the levels are read from (the whole recording for a melody,
 * the low-passed one for a bass); a repeated note is a dip of `dipDb` in the level and back. Levels are relative to the loudest notes (the 95th percentile), so one stray peak does not
 * make everything else quiet.
 */
export function heardNotesFrom(
  notes: readonly PitchNote[],
  mono: Float32Array,
  sampleRate: number,
  sensitivity: number,
  dipDb = DEFAULT_DIP_DB,
): HeardNote[] {
  const curve = levelCurveDb(mono, sampleRate);
  const minSec = lerp(MIN_NOTE_SEC, sensitivity);
  const measured = notes
    .flatMap((note) => pieces(note, curve, dipDb))
    .filter((p) => p.to - p.from >= minSec)
    .map((p) => ({ ...p, db: noteLevelDb(curve, p.from, p.to) }));
  if (measured.length === 0) return [];
  const top = percentile(measured.map((m) => m.db), TOP_SHARE);
  const floor = lerp(FLOOR_DB, sensitivity);
  return measured
    .filter((m) => m.db >= top - floor)
    .map((m) => ({ fromSec: m.from, toSec: m.to, pitch: m.pitch, level: levelShare(m.db, top, floor) }));
}

/** 1 for the loudest notes, down to 0.1 at the floor. */
function levelShare(db: number, top: number, floorDb: number): number {
  return Math.max(0.1, Math.min(1, 1 - (top - db) / floorDb));
}
