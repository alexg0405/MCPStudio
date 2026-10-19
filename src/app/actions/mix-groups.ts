import { MASTER, type GroupId, type InsertId, type Project } from '@core/model/types';
import {
  addVca,
  createGroup,
  editGroup,
  joinGroup,
  leaveGroup,
  removeGroup,
  removeVca,
  type GroupEdit,
} from '@core/ops/groups';
import { setSoloSafe } from '@core/ops/mixer';
import { findGroup, groupOfInsert } from '@core/query/mix-groups';
import { insertLabel } from '@core/query/mixer';
import type { Services } from '../services';

// User-level actions for mixer groups and VCAs: each is one undoable edit, used by the mixer, its menus and commands.

/** What people call an insert in undo labels: its name ("Kick"), or "Master". */
function trackName(project: Project, id: InsertId): string {
  return id === MASTER ? 'Master' : (project.mixer.inserts[id]?.name ?? insertLabel(project, id));
}

/** The tracks the mixer's group commands act on: the ones picked with Shift or Ctrl, else the selected track. */
export function pickedInserts(s: Services): InsertId[] {
  const { markedInsertIds, selectedInsertId } = s.session.getState();
  const picked = markedInsertIds.length ? markedInsertIds : selectedInsertId ? [selectedInsertId] : [];
  const project = s.doc.getState().project;
  return picked.filter((id) => id !== MASTER && !!project.mixer.inserts[id]);
}

const NEED_TWO = 'Pick two or more mixer tracks first: Shift-click or Ctrl-click their strips';

/** Makes a group of the picked tracks (they leave any group they were in). Returns its id, or null. */
export function groupPickedTracks(s: Services): GroupId | null {
  const ids = pickedInserts(s);
  if (ids.length < 2) {
    s.session.getState().toast(NEED_TWO, 'error');
    return null;
  }
  let made: GroupId | null = null;
  s.history.transact(`Group ${ids.length} tracks`, (d) => {
    made = createGroup(d, ids);
  });
  return made;
}

/**
 * "Link selected": the quick way to make tracks move together. The picked tracks join the group one of them is
 * already in (the first picked one's), or make a new group when none is in one.
 */
export function linkPickedTracks(s: Services): GroupId | null {
  const ids = pickedInserts(s);
  if (ids.length < 2) {
    s.session.getState().toast(NEED_TWO, 'error');
    return null;
  }
  const mixer = s.doc.getState().project.mixer;
  const existing = ids.map((id) => groupOfInsert(mixer, id)).find((group) => !!group);
  if (!existing) return groupPickedTracks(s);
  s.history.transact(`Link ${ids.length} tracks to ${existing.name}`, (d) => void joinGroup(d, existing.id, ids));
  return existing.id;
}

/** Changes a group's name, colour, links or mode. */
export function editMixGroup(s: Services, groupId: GroupId, edit: GroupEdit, label?: string): void {
  const group = findGroup(s.doc.getState().project.mixer, groupId);
  if (!group) return;
  s.history.transact(label ?? `Edit group ${group.name}`, (d) => editGroup(d, groupId, edit));
}

/** Deletes a group; its tracks stay as they are. */
export function removeMixGroup(s: Services, groupId: GroupId): void {
  const group = findGroup(s.doc.getState().project.mixer, groupId);
  if (group) s.history.transact(`Remove group ${group.name}`, (d) => removeGroup(d, groupId));
}

/** Takes one track out of its group. */
export function leaveMixGroup(s: Services, insertId: InsertId): void {
  const project = s.doc.getState().project;
  const group = groupOfInsert(project.mixer, insertId);
  if (group) s.history.transact(`Take ${trackName(project, insertId)} out of ${group.name}`, (d) => leaveGroup(d, insertId));
}

/** Gives a group a VCA fader (at 0 dB), or takes it away. */
export function setGroupVca(s: Services, groupId: GroupId, hasVca: boolean): void {
  const group = findGroup(s.doc.getState().project.mixer, groupId);
  if (!group || (group.vca !== undefined) === hasVca) return;
  s.history.transact(`${hasVca ? 'Add a VCA to' : 'Remove the VCA of'} ${group.name}`, (d) =>
    hasVca ? addVca(d, groupId) : removeVca(d, groupId),
  );
}

/** Picks every track of a group (so Shift-moves, "Group" and the menus act on all of them). */
export function pickGroupMembers(s: Services, groupId: GroupId): void {
  const group = findGroup(s.doc.getState().project.mixer, groupId);
  if (!group) return;
  const session = s.session.getState();
  session.selectInsert(group.members[0] ?? null);
  session.markInserts(group.members);
}

/** Marks a track solo-safe (a solo elsewhere does not silence it) or not. */
export function setInsertSoloSafe(s: Services, insertId: InsertId, isSafe: boolean): void {
  const project = s.doc.getState().project;
  if (!project.mixer.inserts[insertId]) return;
  s.history.transact(`${isSafe ? 'Make' : 'Stop making'} ${trackName(project, insertId)} solo-safe`, (d) =>
    setSoloSafe(d, insertId, isSafe),
  );
}
