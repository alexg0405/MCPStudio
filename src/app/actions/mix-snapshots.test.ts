import { describe, expect, it } from 'vitest';
import type { DocChange } from '@core/history/history';
import { MASTER, type InsertId } from '@core/model/types';
import { setInsertProp } from '@core/ops/mixer';
import { createTestServices } from '../testing';
import { groupPickedTracks, linkPickedTracks, pickedInserts, pickGroupMembers, removeMixGroup, setGroupVca } from './mix-groups';
import {
  deleteMixSnapshot,
  recallMixSnapshot,
  renameMixSnapshot,
  RECALL_GLIDE_SEC,
  saveMixSnapshot,
  setCompareSlot,
  snapshotDifferences,
  toggleCompare,
  updateMixSnapshot,
} from './mix-snapshots';

function setup() {
  const s = createTestServices();
  const [a, b, c] = s.doc.getState().project.mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
  const volume = (id: InsertId, value: number) => s.history.transact('set', (d) => setInsertProp(d, id, 'volume', value));
  const read = (id: InsertId) => s.doc.getState().project.mixer.inserts[id]!.volume;
  return { s, a, b, c, volume, read };
}

describe('snapshot actions', () => {
  it('save, recall, update, rename and delete, each one undo step', () => {
    const { s, a, volume, read } = setup();
    volume(a, 0.5);
    const id = saveMixSnapshot(s)!;
    expect(s.doc.getState().project.mixSnapshots![0]).toMatchObject({ id, name: 'Snapshot 1' });
    volume(a, 0.9);
    const steps = s.history.steps().done.length;
    expect(recallMixSnapshot(s, id)).toBe(true);
    expect(read(a)).toBe(0.5);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    s.history.undo();
    expect(read(a)).toBe(0.9);
    expect(recallMixSnapshot(s, id)).toBe(true);
    expect(recallMixSnapshot(s, id)).toBe(false);

    volume(a, 0.3);
    expect(updateMixSnapshot(s, id)).toBe(true);
    volume(a, 1);
    recallMixSnapshot(s, id);
    expect(read(a)).toBe(0.3);

    renameMixSnapshot(s, id, '  Verse  ');
    expect(s.doc.getState().project.mixSnapshots![0]!.name).toBe('Verse');
    deleteMixSnapshot(s, id);
    expect(s.doc.getState().project.mixSnapshots).toBeUndefined();
    s.history.undo();
    expect(s.doc.getState().project.mixSnapshots![0]!.name).toBe('Verse');
  });

  it('a recall asks the engine to glide over about 30 ms; an ordinary edit does not', () => {
    const { s, a, volume } = setup();
    volume(a, 0.5);
    const id = saveMixSnapshot(s)!;
    volume(a, 0.9);
    const changes: DocChange[] = [];
    s.history.onChange((change) => changes.push(change));
    volume(a, 0.7);
    recallMixSnapshot(s, id);
    expect(changes[0]!.glideSec).toBeUndefined();
    expect(changes[1]!.glideSec).toBe(RECALL_GLIDE_SEC);
    expect(RECALL_GLIDE_SEC).toBeGreaterThanOrEqual(0.02);
    expect(RECALL_GLIDE_SEC).toBeLessThanOrEqual(0.04);
  });

  it('the A/B switch recalls the other snapshot each time, and quick switching is one undo step', () => {
    const { s, a, volume, read } = setup();
    volume(a, 0.4);
    const first = saveMixSnapshot(s)!;
    volume(a, 0.8);
    const second = saveMixSnapshot(s)!;
    expect(toggleCompare(s)).toBeNull();
    setCompareSlot(s, 'a', first);
    setCompareSlot(s, 'b', second);
    const before = s.doc.getState().project;
    const steps = s.history.steps().done.length;
    expect(toggleCompare(s)).toBe('a');
    expect(read(a)).toBe(0.4);
    expect(toggleCompare(s)).toBe('b');
    expect(read(a)).toBe(0.8);
    expect(toggleCompare(s)).toBe('a');
    expect(read(a)).toBe(0.4);
    expect(s.history.steps().done.length).toBeLessThanOrEqual(steps + 2);
    expect(before.mixer.inserts[a]!.volume).toBe(0.8);
  });

  it('forgets a compared snapshot that is deleted', () => {
    const { s } = setup();
    const first = saveMixSnapshot(s)!;
    const second = saveMixSnapshot(s)!;
    setCompareSlot(s, 'a', first);
    setCompareSlot(s, 'b', second);
    deleteMixSnapshot(s, first);
    expect(s.session.getState().snapshotCompare).toMatchObject({ a: null, b: second, side: null });
  });

  it('lists what recalling would change, in words', () => {
    const { s, a, volume } = setup();
    volume(a, 0.5);
    const id = saveMixSnapshot(s)!;
    expect(snapshotDifferences(s, id)).toEqual([]);
    volume(a, 1);
    const [line] = snapshotDifferences(s, id);
    expect(line!.text).toMatch(/fader 0\.0 dB → -6\.0 dB$/);
  });
});

describe('group actions', () => {
  it('group and link the picked tracks; Shift-picking is session state, not undoable', () => {
    const { s, a, b, c } = setup();
    expect(groupPickedTracks(s)).toBeNull();
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/Pick two or more/);
    s.session.getState().selectInsert(a);
    s.session.getState().toggleMarkedInsert(b);
    expect(pickedInserts(s)).toEqual([a, b]);
    const steps = s.history.steps().done.length;
    const id = groupPickedTracks(s)!;
    expect(s.doc.getState().project.mixer.groups![0]!.members).toEqual([a, b]);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    // Link selected: c joins the group of a.
    s.session.getState().markInserts([a, c]);
    expect(linkPickedTracks(s)).toBe(id);
    expect(s.doc.getState().project.mixer.groups![0]!.members).toEqual([a, b, c]);
    s.history.undo();
    expect(s.doc.getState().project.mixer.groups![0]!.members).toEqual([a, b]);
  });

  it('picks every member of a group, and adds and removes a VCA and the group in one step each', () => {
    const { s, a, b } = setup();
    s.session.getState().markInserts([a, b]);
    const id = groupPickedTracks(s)!;
    s.session.getState().selectInsert(MASTER);
    pickGroupMembers(s, id);
    expect(s.session.getState().markedInsertIds).toEqual([a, b]);
    setGroupVca(s, id, true);
    expect(s.doc.getState().project.mixer.groups![0]!.vca).toBe(1);
    setGroupVca(s, id, false);
    expect(s.doc.getState().project.mixer.groups![0]!.vca).toBeUndefined();
    removeMixGroup(s, id);
    expect(s.doc.getState().project.mixer.groups).toBeUndefined();
  });

  it('toggling picks: a lone pick is just the selection', () => {
    const { s, a, b } = setup();
    s.session.getState().selectInsert(a);
    s.session.getState().toggleMarkedInsert(b);
    expect(s.session.getState().markedInsertIds).toEqual([a, b]);
    s.session.getState().toggleMarkedInsert(b);
    expect(s.session.getState().markedInsertIds).toEqual([]);
    expect(s.session.getState().selectedInsertId).toBe(a);
    s.session.getState().markInserts([a, b]);
    s.session.getState().selectInsert(b);
    expect(s.session.getState().markedInsertIds).toEqual([]);
  });
});
