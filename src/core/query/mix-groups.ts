/** Mixer group queries shared by the engine, the UI and the AI: who is in which group, and what a VCA does. */
import type { GroupId, InsertId, Mixer, MixGroup } from '../model/types';

/** The groups of a mixer, in order (a stable empty list when there are none). */
export function groupsOf(mixer: Mixer): readonly MixGroup[] {
  return mixer.groups ?? NO_GROUPS;
}

const NO_GROUPS: readonly MixGroup[] = [];

/** A group by id. */
export function findGroup(mixer: Mixer, id: GroupId): MixGroup | undefined {
  return mixer.groups?.find((group) => group.id === id);
}

/** The group a track belongs to, if any (a track is in at most one). */
export function groupOfInsert(mixer: Mixer, insertId: InsertId): MixGroup | undefined {
  return mixer.groups?.find((group) => group.members.includes(insertId));
}

/**
 * The group a track belongs to when that group links `control` (so editing the track edits the others), else
 * undefined. Only groups with at least two members link anything.
 */
export function linkedGroupOf(
  mixer: Mixer,
  insertId: InsertId,
  control: 'volume' | 'pan' | 'mute' | 'solo',
): MixGroup | undefined {
  const group = groupOfInsert(mixer, insertId);
  return group && group.members.length > 1 && group.links[control] ? group : undefined;
}

/** The VCA gain (linear, 1 = 0 dB) that scales a track's level: its group's VCA, or 1 when there is none. */
export function vcaGainOf(mixer: Mixer, insertId: InsertId): number {
  return groupOfInsert(mixer, insertId)?.vca ?? 1;
}

/** The groups that have a VCA fader, in order. */
export function vcaGroups(mixer: Mixer): MixGroup[] {
  return groupsOf(mixer).filter((group) => group.vca !== undefined);
}

/** Which group's VCA scales each track, with its level (linear gain): only tracks whose group has a VCA are listed. */
export function vcaOfInserts(mixer: Mixer): Map<InsertId, { groupId: GroupId; level: number }> {
  const out = new Map<InsertId, { groupId: GroupId; level: number }>();
  for (const group of mixer.groups ?? []) {
    if (group.vca === undefined) continue;
    for (const member of group.members) out.set(member, { groupId: group.id, level: group.vca });
  }
  return out;
}
