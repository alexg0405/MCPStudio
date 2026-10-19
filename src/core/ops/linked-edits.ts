/**
 * Edits that move a group's members together. Linking lives here, not in `setInsertProp`, which stays a plain
 * single-track write: snapshot recall, the AI and controller links write exact values to exactly the track they name.
 * Call these inside history.transact()/gesture() recipes.
 */
import type { Draft } from 'immer';
import { MASTER, type GroupMode, type InsertId, type MixGroup, type Project } from '../model/types';
import { linkedGroupOf } from '../query/mix-groups';
import { setInsertProp } from './mixer';

/** The two linked controls that move by value (mute and solo are switches). */
export type LinkedControl = 'volume' | 'pan';

/** Writes a fader or pan value to a track and to whatever the track's group links to it. */
export type LinkedEdit = (d: Draft<Project>, value: number) => void;

/** What a plan remembers about the group when it is made. */
interface StartValues {
  /** The edited track's value. */
  moved: number;
  /** Its group mates' values. */
  mates: { id: InsertId; value: number }[];
}

/**
 * Plans an edit of one track's fader or pan. It reads the values of the track and of its linked group mates now, so
 * that a drag is computed from where it started (the recipe is absolute: running it again with the same value gives
 * the same result, and dragging back puts everyone back, even where a mate hit the end of its travel on the way).
 * A track outside a group, or in one that does not link this control, gets a plain single-track edit.
 */
export function planLinkedEdit(project: Project, insertId: InsertId, control: LinkedControl): LinkedEdit {
  const group = linkedGroupOf(project.mixer, insertId, control);
  if (!group) return (d, value) => setInsertProp(d, insertId, control, value);
  const start = readStart(project, group, insertId, control);
  return (d, value) => {
    setInsertProp(d, insertId, control, value);
    for (const mate of start.mates) {
      setInsertProp(d, mate.id, control, linkedValue(group.mode, control, start.moved, mate.value, value));
    }
  };
}

function readStart(project: Project, group: MixGroup, insertId: InsertId, control: LinkedControl): StartValues {
  const fallback = control === 'volume' ? 1 : 0;
  const read = (id: InsertId) => project.mixer.inserts[id]?.[control] ?? fallback;
  const mates = group.members.filter((id) => id !== insertId && project.mixer.inserts[id]);
  return { moved: read(insertId), mates: mates.map((id) => ({ id, value: read(id) })) };
}

/**
 * What a group mate becomes when the moved track goes from `movedStart` to `value`.
 * Absolute: the same value. Relative: faders keep their ratio (the same distance in dB), pans their offset.
 * A fader that starts at silence has no ratio, so its mates stay where they were.
 */
export function linkedValue(
  mode: GroupMode,
  control: LinkedControl,
  movedStart: number,
  mateStart: number,
  value: number,
): number {
  if (mode === 'absolute') return value;
  if (control === 'pan') return mateStart + (value - movedStart);
  return movedStart > 0 ? mateStart * (value / movedStart) : mateStart;
}

/** Mutes or unmutes a track, and its group mates when the group links mute. */
export function setMutedLinked(d: Draft<Project>, insertId: InsertId, isMuted: boolean): void {
  const group = linkedGroupOf(d.mixer, insertId, 'mute');
  for (const id of group ? group.members : [insertId]) setInsertProp(d, id, 'muted', isMuted);
}

/**
 * FL-style exclusive solo for a track and, when its group links solo, for the whole group: soloing one member solos
 * them all (and silences every track outside the group); soloing the group that is already the only solo clears it.
 */
export function toggleSoloLinked(d: Draft<Project>, insertId: InsertId): void {
  if (insertId === MASTER || !d.mixer.inserts[insertId]) return;
  const group = linkedGroupOf(d.mixer, insertId, 'solo');
  const soloing = new Set<InsertId>(group ? group.members : [insertId]);
  const tracks = Object.values(d.mixer.inserts).filter((insert) => insert.id !== MASTER);
  const isOnlySolo = tracks.every((insert) => insert.solo === soloing.has(insert.id));
  for (const insert of tracks) {
    insert.solo = isOnlySolo ? false : soloing.has(insert.id);
    if (!isOnlySolo && soloing.has(insert.id)) insert.muted = false;
  }
}
