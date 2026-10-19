/**
 * Pure draft mutators for mixer groups and VCAs: who is in a group, how it is set up, and the VCA level. Call them
 * inside history.transact()/gesture() recipes. The edits that move a group's members together are in
 * `linked-edits.ts`.
 */
import type { Draft } from 'immer';
import { MAX_INSERT_VOLUME } from '../model/fader';
import { paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import { targetUsesGroup } from '../model/targets';
import {
  MASTER,
  type GroupId,
  type GroupLinks,
  type GroupMode,
  type InsertId,
  type MixGroup,
  type Project,
} from '../model/types';
import { findGroup } from '../query/mix-groups';
import { dropControllers } from './channels';

/** The most groups a project keeps. */
export const MAX_GROUPS = 32;

/** What a group's settings can be changed to; absent fields stay as they are. */
export interface GroupEdit {
  name?: string;
  color?: string;
  links?: Partial<GroupLinks>;
  mode?: GroupMode;
}

/** Every link on: how a new group starts. */
export const DEFAULT_LINKS: GroupLinks = { volume: true, pan: true, mute: true, solo: true };

function groupsOf(d: Draft<Project>): Draft<MixGroup>[] {
  return (d.mixer.groups ??= []);
}

/** Drops the `groups` field again when the last group is gone, so a project without groups stays as it was. */
function tidyGroups(d: Draft<Project>): void {
  if (d.mixer.groups && d.mixer.groups.length === 0) delete d.mixer.groups;
}

/** The tracks of `ids` that can be in a group: existing, not the master, each once. */
function usableMembers(d: Draft<Project>, ids: readonly InsertId[]): InsertId[] {
  const seen = new Set<InsertId>();
  const out: InsertId[] = [];
  for (const id of ids) {
    if (id === MASTER || !d.mixer.inserts[id] || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** "Group 3": the first number nobody uses. */
function freeGroupName(d: Draft<Project>): string {
  const taken = new Set(groupsOf(d).map((group) => group.name));
  let n = groupsOf(d).length + 1;
  while (taken.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/** Takes the tracks out of whatever group they are in (a group left with no member goes). */
function leaveGroups(d: Draft<Project>, ids: readonly InsertId[]): void {
  for (const group of [...groupsOf(d)]) {
    group.members = group.members.filter((member) => !ids.includes(member));
    if (group.members.length === 0) removeGroup(d, group.id);
  }
  tidyGroups(d);
}

/**
 * Makes a group of the tracks (those already in a group leave it). Needs at least one usable track. Every link is on,
 * linked faders are relative, and there is no VCA until `addVca`. Returns the new id, or null when nothing was made.
 */
export function createGroup(
  d: Draft<Project>,
  memberIds: readonly InsertId[],
  options: { id?: GroupId; name?: string; color?: string } = {},
): GroupId | null {
  const members = usableMembers(d, memberIds);
  if (members.length === 0 || (d.mixer.groups?.length ?? 0) >= MAX_GROUPS) return null;
  leaveGroups(d, members);
  const id = options.id ?? newId.group();
  const name = options.name?.trim().slice(0, 64) || freeGroupName(d);
  const color = options.color || paletteColor(groupsOf(d).length);
  groupsOf(d).push({ id, name, color, members, links: { ...DEFAULT_LINKS }, mode: 'relative' });
  return id;
}

/** Puts tracks into an existing group (they leave the group they were in). Returns how many joined. */
export function joinGroup(d: Draft<Project>, groupId: GroupId, ids: readonly InsertId[]): number {
  const existing = findGroup(d.mixer, groupId);
  if (!existing) return 0;
  const joining = usableMembers(d, ids).filter((id) => !existing.members.includes(id));
  if (joining.length === 0) return 0;
  leaveGroups(d, joining);
  const group = groupsOf(d).find((g) => g.id === groupId);
  if (!group) return 0;
  group.members.push(...joining);
  return joining.length;
}

/** Takes one track out of its group (the group goes when it was the last one). */
export function leaveGroup(d: Draft<Project>, insertId: InsertId): void {
  leaveGroups(d, [insertId]);
}

/** Deletes a group (its tracks stay as they are) and the controller links to its VCA. */
export function removeGroup(d: Draft<Project>, groupId: GroupId): void {
  const groups = d.mixer.groups;
  const index = groups?.findIndex((group) => group.id === groupId) ?? -1;
  if (!groups || index < 0) return;
  groups.splice(index, 1);
  dropControllers(d, (target) => targetUsesGroup(target, groupId));
  tidyGroups(d);
}

/** After a track is deleted: it leaves its group, and an empty group goes with it. */
export function dropFromGroups(d: Draft<Project>, insertId: InsertId): void {
  if (d.mixer.groups) leaveGroups(d, [insertId]);
}

/** Changes a group's name, colour, links or mode. */
export function editGroup(d: Draft<Project>, groupId: GroupId, edit: GroupEdit): void {
  const group = d.mixer.groups?.find((g) => g.id === groupId);
  if (!group) return;
  const name = edit.name?.trim().slice(0, 64);
  if (name) group.name = name;
  if (edit.color) group.color = edit.color;
  if (edit.mode) group.mode = edit.mode;
  for (const control of ['volume', 'pan', 'mute', 'solo'] as const) {
    const isOn = edit.links?.[control];
    if (isOn !== undefined) group.links[control] = Boolean(isOn);
  }
}

/** Gives the group a VCA fader at `gain` (linear, default unity). */
export function addVca(d: Draft<Project>, groupId: GroupId, gain = 1): void {
  const group = d.mixer.groups?.find((g) => g.id === groupId);
  if (group && group.vca === undefined) group.vca = clampVca(gain);
}

/** Takes the group's VCA away: the members play at their own faders again. */
export function removeVca(d: Draft<Project>, groupId: GroupId): void {
  const group = d.mixer.groups?.find((g) => g.id === groupId);
  if (!group || group.vca === undefined) return;
  delete group.vca;
  dropControllers(d, (target) => targetUsesGroup(target, groupId));
}

/** Sets the VCA level (linear gain, 0 … +5.6 dB). Ignored for a group without a VCA. */
export function setVcaLevel(d: Draft<Project>, groupId: GroupId, gain: number): void {
  const group = d.mixer.groups?.find((g) => g.id === groupId);
  if (group && group.vca !== undefined) group.vca = clampVca(gain);
}

function clampVca(gain: number): number {
  return Number.isFinite(gain) ? Math.min(MAX_INSERT_VOLUME, Math.max(0, gain)) : 1;
}
