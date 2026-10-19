/**
 * "Match the key": which key the musician's song is in (the song key setting, else what its notes say),
 * how many semitones move it to the reference's key, and moving the pitched notes (drums stay). Moving the
 * musician's own notes up or down is the only thing done to them: no note of the reference is ever read.
 */
import type { Draft } from 'immer';
import { notesHash, eachNote } from '../arrange/notes';
import { isBassRole, isMusicRole, type Role } from '../arrange/roles';
import { keyName, keyScores } from '../dj/key';
import type { ChannelId, PatternId, Project } from '../model/types';

/** A key: its tonic as a pitch class (0 = C) and whether it is major or minor. */
export interface KeyInfo {
  root: number;
  mode: 'major' | 'minor';
}

/** Scales that sound minor (the third is flat). */
const MINOR_SCALES = /minor|aeolian|dorian|phrygian|locrian|blues/i;
/** Whether a scale id sounds major or minor: scales with a flat third count as minor. */
export const modeOfScale = (scale: string): 'major' | 'minor' => (MINOR_SCALES.test(scale) ? 'minor' : 'major');

const mod12 = (x: number) => ((Math.round(x) % 12) + 12) % 12;

/**
 * The song's key: the key setting when there is one, else the best fit of its pitched notes (null when
 * there are too few to say, or they fit no key well).
 */
export function projectKey(p: Project, roles: ReadonlyMap<ChannelId, Role>): (KeyInfo & { from: 'setting' | 'notes' }) | null {
  const set = p.transport.key;
  if (set) return { root: mod12(set.root), mode: modeOfScale(set.scale), from: 'setting' };
  const profile = new Float64Array(12);
  let notes = 0;
  for (const pid of p.patternOrder) {
    const pat = p.patterns[pid];
    if (!pat || pat.derived) continue;
    eachNote(pat.notes, (cid, n) => {
      const r = roles.get(cid) ?? 'other';
      if (!isMusicRole(r) && !isBassRole(r)) return;
      profile[mod12(n.key)] = profile[mod12(n.key)]! + Math.min(n.length, 1920);
      notes++;
    });
  }
  if (notes < 6) return null;
  const total = profile.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  for (let i = 0; i < 12; i++) profile[i] = profile[i]! / total;
  const scores = keyScores(profile);
  let best = 0;
  for (let i = 1; i < 24; i++) if (scores[i]! > scores[best]!) best = i;
  if (scores[best]! < 0.5) return null;
  return { root: best % 12, mode: best >= 12 ? 'minor' : 'major', from: 'notes' };
}

/**
 * The move that takes the song to the reference's key: how many semitones (-6 to 5), the key it ends up in and whether
 * it got there through the relative key.
 */
export interface KeyMove {
  /** −6…+5: how far the pitched notes move. */
  semitones: number;
  /** The key the song is in after the move (the song's own mode: a relative key counts). */
  to: KeyInfo;
  /** True when the reference's key was reached through its relative major or minor (the notes are the same either way). */
  relative: boolean;
}

/**
 * The shortest move that puts the song in the reference's key. When one is major and the other minor, the
 * song goes to the reference's relative key (C major and A minor share their notes), so it keeps its mode.
 */
export function keyMove(from: KeyInfo, ref: KeyInfo): KeyMove {
  const relative = from.mode !== ref.mode;
  // A minor song matches a major reference through its relative minor (3 semitones down), and the other way round.
  const targetRoot = relative ? (from.mode === 'minor' ? ref.root - 3 : ref.root + 3) : ref.root;
  let semitones = mod12(targetRoot - from.root);
  if (semitones > 5) semitones -= 12;
  return { semitones, to: { root: mod12(from.root + semitones), mode: from.mode }, relative };
}

/** A key written for people, like "A minor". */
export const keyText = (k: KeyInfo): string => keyName(k);

/**
 * Moves the pitched notes (instruments and basses; drums and anything unknown stay) of every pattern by
 * `semitones`. A note that would leave 0–127 goes an octave back. Variants are moved with their sources and
 * keep their link. Returns how many notes moved.
 */
export function transposeSong(d: Draft<Project>, roles: ReadonlyMap<ChannelId, Role>, semitones: number): number {
  if (!semitones) return 0;
  let moved = 0;
  for (const pid of d.patternOrder) {
    const pat = d.patterns[pid];
    if (!pat) continue;
    const clean = !!pat.derived && notesHash(pat.notes as Project['patterns'][PatternId]['notes']) === pat.derived.hash;
    let touched = false;
    for (const [cid, byId] of Object.entries(pat.notes)) {
      const r = roles.get(cid as ChannelId) ?? 'other';
      if (!isMusicRole(r) && !isBassRole(r)) continue;
      for (const n of Object.values(byId)) {
        let key = n.key + semitones;
        if (key > 127) key -= 12;
        if (key < 0) key += 12;
        n.key = key;
        moved++;
        touched = true;
      }
    }
    // A variant stays "unmodified" (it is rebuilt from its source when that changes).
    if (touched && clean && pat.derived) pat.derived.hash = notesHash(pat.notes as Project['patterns'][PatternId]['notes']);
  }
  return moved;
}
