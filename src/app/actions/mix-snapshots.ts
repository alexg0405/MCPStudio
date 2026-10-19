import type { MixSnapshot, SnapshotId } from '@core/model/types';
import {
  addSnapshot,
  deleteSnapshot,
  freeSnapshotName,
  MAX_SNAPSHOTS,
  renameSnapshot,
  replaceSnapshotState,
} from '@core/ops/snapshots';
import { captureSnapshot } from '@core/snapshots/capture';
import { diffAgainstCurrent, diffBetween, type MixDifference } from '@core/snapshots/diff';
import { recallSnapshot } from '@core/snapshots/recall';
import type { Services } from '../services';

// User-level actions for mixer snapshots: each is one undoable edit that touches only the mixer's values.

/** A recalled fader, pan, mute or send glides over this long, so switching while the song plays does not click. */
export const RECALL_GLIDE_SEC = 0.03;

/** Quick A/B switches within this long fold into one undo step (the document history's own window is 1 s). */
const COMPARE_MERGE_KEY = 'mix-snapshot-compare';

function snapshotOf(s: Services, id: SnapshotId | null): MixSnapshot | undefined {
  return id ? s.doc.getState().project.mixSnapshots?.find((snapshot) => snapshot.id === id) : undefined;
}

/** Saves the mixer as it is now under a name (default "Snapshot 3"). Returns its id, or null when the list is full. */
export function saveMixSnapshot(s: Services, options: { name?: string; routing?: boolean } = {}): SnapshotId | null {
  const project = s.doc.getState().project;
  if ((project.mixSnapshots?.length ?? 0) >= MAX_SNAPSHOTS) {
    s.session.getState().toast(`A project keeps at most ${MAX_SNAPSHOTS} snapshots: delete one first`, 'error');
    return null;
  }
  const name = options.name?.trim() || freeSnapshotName(project.mixSnapshots);
  const snapshot = captureSnapshot(project, name, Date.now(), { routing: options.routing ?? false });
  s.history.transact(`Save snapshot ${name}`, (d) => void addSnapshot(d, snapshot));
  return snapshot.id;
}

/**
 * Puts a snapshot's values back: faders, pans, mutes, solos, sends, effect settings and VCA levels (and the routing,
 * when it was saved with it). One undo step; it never touches notes or the arrangement. While the song plays, faders
 * glide to their new places. Returns false when there is no such snapshot or the mix already matches it.
 */
export function recallMixSnapshot(s: Services, id: SnapshotId, options: { routing?: boolean; merge?: boolean } = {}): boolean {
  const snapshot = snapshotOf(s, id);
  if (!snapshot) return false;
  const routing = options.routing;
  return s.history.transact(
    `Recall snapshot ${snapshot.name}`,
    (d) => void recallSnapshot(d, snapshot, routing === undefined ? {} : { routing }),
    { glideSec: RECALL_GLIDE_SEC, ...(options.merge ? { mergeKey: COMPARE_MERGE_KEY } : {}) },
  );
}

/** Saves the mixer as it is now into an existing snapshot (it keeps its name, and its routing if it had it). */
export function updateMixSnapshot(s: Services, id: SnapshotId): boolean {
  const old = snapshotOf(s, id);
  if (!old) return false;
  const fresh = captureSnapshot(s.doc.getState().project, old.name, Date.now(), { routing: !!old.routing });
  return s.history.transact(`Update snapshot ${old.name}`, (d) => replaceSnapshotState(d, id, fresh));
}

export function renameMixSnapshot(s: Services, id: SnapshotId, name: string): void {
  const old = snapshotOf(s, id);
  if (old && name.trim() && name.trim() !== old.name) {
    s.history.transact(`Rename snapshot ${old.name}`, (d) => renameSnapshot(d, id, name));
  }
}

export function deleteMixSnapshot(s: Services, id: SnapshotId): void {
  const old = snapshotOf(s, id);
  if (old) s.history.transact(`Delete snapshot ${old.name}`, (d) => deleteSnapshot(d, id));
}

/** What recalling the snapshot would change in the mix as it is now, as a list of plain sentences. */
export function snapshotDifferences(s: Services, id: SnapshotId): MixDifference[] {
  const snapshot = snapshotOf(s, id);
  return snapshot ? diffAgainstCurrent(s.doc.getState().project, snapshot, s.automation.pluginInfo) : [];
}

/** What switching from one snapshot to the other changes. */
export function snapshotDifferencesBetween(s: Services, from: SnapshotId, to: SnapshotId): MixDifference[] {
  const a = snapshotOf(s, from);
  const b = snapshotOf(s, to);
  return a && b ? diffBetween(s.doc.getState().project, a, b, s.automation.pluginInfo) : [];
}

/** Sets snapshot A or B of the A/B compare (null clears it). */
export function setCompareSlot(s: Services, slot: 'a' | 'b', id: SnapshotId | null): void {
  const compare = s.session.getState().snapshotCompare;
  const patch = slot === 'a' ? { a: id } : { b: id };
  // The side only means something while both are set; picking a slot starts the compare over.
  s.session.getState().setSnapshotCompare({ ...patch, side: compare[slot] === id ? compare.side : null });
}

/**
 * The A/B switch: recalls the other snapshot of the pair (A first). It is a recall like any other, glided so it does
 * not click, and quick back-and-forth folds into one undo step. Returns the side now playing, or null when the pair
 * is not complete.
 */
export function toggleCompare(s: Services): 'a' | 'b' | null {
  const { a, b, side } = s.session.getState().snapshotCompare;
  if (!snapshotOf(s, a) || !snapshotOf(s, b)) return null;
  const next = side === 'a' ? 'b' : 'a';
  recallMixSnapshot(s, (next === 'a' ? a : b)!, { merge: true });
  s.session.getState().setSnapshotCompare({ side: next });
  return next;
}
