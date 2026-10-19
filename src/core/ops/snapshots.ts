/**
 * Pure draft mutators for the list of mixer snapshots (`Project.mixSnapshots`). Recalling one is
 * `core/snapshots/recall.ts`. Call these inside history.transact() recipes.
 */
import type { Draft } from 'immer';
import type { MixSnapshot, Project, SnapshotId } from '../model/types';

/** The most snapshots a project keeps (each is a few kilobytes: values only). */
export const MAX_SNAPSHOTS = 64;

function snapshotsOf(d: Draft<Project>): Draft<MixSnapshot>[] {
  return (d.mixSnapshots ??= []);
}

/** "Snapshot 4": the first number nobody uses. */
export function freeSnapshotName(snapshots: readonly MixSnapshot[] | undefined): string {
  const taken = new Set((snapshots ?? []).map((snapshot) => snapshot.name));
  let n = (snapshots?.length ?? 0) + 1;
  while (taken.has(`Snapshot ${n}`)) n++;
  return `Snapshot ${n}`;
}

/** Adds a snapshot at the end of the list. Returns false when the list is full. */
export function addSnapshot(d: Draft<Project>, snapshot: MixSnapshot): boolean {
  if ((d.mixSnapshots?.length ?? 0) >= MAX_SNAPSHOTS) return false;
  snapshotsOf(d).push(snapshot as Draft<MixSnapshot>);
  return true;
}

/** Replaces what a snapshot holds with a newer capture, keeping its id and name. */
export function replaceSnapshotState(d: Draft<Project>, id: SnapshotId, fresh: MixSnapshot): void {
  const list = d.mixSnapshots;
  const index = list?.findIndex((snapshot) => snapshot.id === id) ?? -1;
  if (!list || index < 0) return;
  const old = list[index]!;
  list[index] = { ...(fresh as Draft<MixSnapshot>), id: old.id, name: old.name };
}

/** Renames a snapshot (an empty name is ignored). */
export function renameSnapshot(d: Draft<Project>, id: SnapshotId, name: string): void {
  const snapshot = d.mixSnapshots?.find((candidate) => candidate.id === id);
  const trimmed = name.trim().slice(0, 64);
  if (snapshot && trimmed) snapshot.name = trimmed;
}

/** Deletes a snapshot; the field goes with the last one. */
export function deleteSnapshot(d: Draft<Project>, id: SnapshotId): void {
  const list = d.mixSnapshots;
  const index = list?.findIndex((snapshot) => snapshot.id === id) ?? -1;
  if (!list || index < 0) return;
  list.splice(index, 1);
  if (list.length === 0) delete d.mixSnapshots;
}
