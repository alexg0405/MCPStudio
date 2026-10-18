/**
 * Which key harmony works in: the song key the musician set, else the key their notes suggest, else a plain default. A
 * progression written for the other mode (a minor loop in a major song) is moved to the relative key, which has the same notes.
 */
import type { ChannelId, Project } from '../model/types';
import type { Role } from '../arrange/roles';
import { projectKey } from '../reference/key';
import { mod12 } from './chord';
import { keyMode, type KeyLike } from './scale';

/** The key, and where it came from. */
export interface HarmonyKey extends KeyLike {
  from: 'song' | 'notes' | 'default';
}

/** Semitones from a major key up to its relative minor, and the other way. */
const RELATIVE_MINOR_UP = 9;
const RELATIVE_MAJOR_UP = 3;

/** The key harmony uses. `fallbackMode` is the mode of a default key when nothing says (A minor or C major). */
export function harmonyKey(project: Project, roles: ReadonlyMap<ChannelId, Role>, fallbackMode: 'major' | 'minor' = 'minor'): HarmonyKey {
  const set = project.transport.key;
  if (set) return { root: mod12(set.root), scale: set.scale, from: 'song' };
  const found = projectKey(project, roles);
  if (found) return { root: found.root, scale: found.mode, from: found.from === 'setting' ? 'song' : 'notes' };
  return fallbackMode === 'minor' ? { root: 9, scale: 'minor', from: 'default' } : { root: 0, scale: 'major', from: 'default' };
}

/** The key to write a progression of `mode` in: the key itself, or its relative key when the modes differ. */
export function keyForMode(key: KeyLike, mode: 'major' | 'minor'): KeyLike {
  if (keyMode(key.scale) === mode) return key;
  if (mode === 'minor') return { root: mod12(key.root + RELATIVE_MINOR_UP), scale: 'minor' };
  return { root: mod12(key.root + RELATIVE_MAJOR_UP), scale: 'major' };
}
