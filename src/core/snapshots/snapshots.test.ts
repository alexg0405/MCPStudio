import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { p as param } from '@agstudio/sdk/params';
import type { PluginInfoResolver } from '../automation/labels';
import { History } from '../history/history';
import { createEmptyProject, makeInsert, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { MASTER, type InsertId, type Project, type SlotId } from '../model/types';
import { addVca, createGroup, setVcaLevel } from '../ops/groups';
import { addFxSlot, addInsert, removeInsert, setFxSlotEnabled, setFxSlotMix, setInsertProp } from '../ops/mixer';
import { setPluginParam } from '../ops/channels';
import { clearRoutes, setRoute, setRouteLevel, setSlotSidechain } from '../ops/routing';
import { addSnapshot, deleteSnapshot, freeSnapshotName, renameSnapshot, replaceSnapshotState } from '../ops/snapshots';
import { captureMixerState, captureSnapshot } from './capture';
import { diffAgainstCurrent, diffBetween } from './diff';
import { recallSnapshot } from './recall';

beforeEach(() => setIdSource(seededBytes(3)));

const plugins: PluginInfoResolver = (id) =>
  id === 'test.eq'
    ? { name: 'EQ', params: { gain: param.float(-12, 12, 0, { label: 'Gain', unit: 'dB' }), on: param.bool(true, { label: 'On' }) } }
    : undefined;

/** Three tracks with effects, a send, a group with a VCA: something with every kind of value in it. */
function mix() {
  const empty = createEmptyProject({ now: new Date(0) });
  const [a, b, c] = empty.mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
  let slotA!: SlotId;
  let slotB!: SlotId;
  const project = produce(empty, (d) => {
    setInsertProp(d, a, 'name', 'Kick');
    setInsertProp(d, b, 'name', 'Reverb');
    setInsertProp(d, a, 'volume', 0.8);
    setInsertProp(d, a, 'pan', -0.25);
    setRoute(d, a, b, { level: 0.5 });
    slotA = addFxSlot(d, a, makePluginInstance('test.eq', 1, { gain: 3, on: true }))!;
    slotB = addFxSlot(d, b, makePluginInstance('test.eq', 1, { gain: -2, on: true }))!;
    const id = createGroup(d, [a, c], { name: 'Drums' })!;
    addVca(d, id, 0.9);
  });
  return { project, a, b, c, slotA, slotB };
}

/** Changes every kind of value the snapshot keeps. */
function scramble(project: Project, ids: ReturnType<typeof mix>): Project {
  const { a, b, c, slotA, slotB } = ids;
  return produce(project, (d) => {
    setInsertProp(d, a, 'volume', 0.2);
    setInsertProp(d, b, 'volume', 1.5);
    setInsertProp(d, c, 'pan', 0.9);
    setInsertProp(d, c, 'muted', true);
    setInsertProp(d, b, 'solo', true);
    setInsertProp(d, MASTER, 'volume', 0.4);
    setRouteLevel(d, a, b, 0.1);
    setFxSlotEnabled(d, a, slotA, false);
    setFxSlotMix(d, b, slotB, 0.25);
    setPluginParam(d, { kind: 'fx', insertId: a, slotId: slotA }, 'gain', -9);
    setPluginParam(d, { kind: 'fx', insertId: b, slotId: slotB }, 'gain', 7);
    setVcaLevel(d, d.mixer.groups![0]!.id, 0.3);
  });
}

describe('capture', () => {
  it('keeps only values, for every track including the master', () => {
    const { project, a, b } = mix();
    const state = captureMixerState(project);
    expect(Object.keys(state.inserts)).toEqual(project.mixer.order);
    expect(state.inserts[a]).toMatchObject({ name: 'Kick', volume: 0.8, pan: -0.25, muted: false, solo: false });
    expect(state.inserts[a]!.sends).toEqual({ [MASTER]: 1, [b]: 0.5 });
    expect(Object.values(state.inserts[a]!.fx)[0]).toEqual({ plugin: 'test.eq', enabled: true, mix: 1, params: { gain: 3, on: true } });
    expect(state.vca).toEqual({ [project.mixer.groups![0]!.id]: 0.9 });
    expect(state.routing).toBeUndefined();
  });

  it('keeps routing only when asked, and stays small', () => {
    const { project, a, b } = mix();
    const withRouting = captureSnapshot(project, 'Intro', 1000, { routing: true });
    expect(withRouting.routing![a]!.routes).toEqual([{ to: MASTER, pre: false }, { to: b, pre: false }]);
    expect(JSON.stringify(captureSnapshot(project, 'Intro', 1000)).length).toBeLessThan(3000);
  });

  it('shares nothing with the project: the snapshot is a copy of the values', () => {
    const { project, a, slotA } = mix();
    const snap = captureSnapshot(project, 'Intro', 1);
    const changed = scramble(project, mix());
    expect(snap.inserts[a]!.fx[slotA]!.params.gain).toBe(3);
    expect(changed).not.toBe(project);
  });
});

describe('recall', () => {
  it('restores every stored value exactly', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1, { routing: true });
    const changed = scramble(ids.project, ids);
    expect(captureMixerState(changed, { routing: true })).not.toEqual(captureMixerState(ids.project, { routing: true }));
    const recalled = produce(changed, (d) => void recallSnapshot(d, snap));
    expect(captureMixerState(recalled, { routing: true })).toEqual(captureMixerState(ids.project, { routing: true }));
    expect(recalled.mixer.inserts).toEqual(ids.project.mixer.inserts);
    expect(recalled.mixer.groups).toEqual(ids.project.mixer.groups);
  });

  it('is one undo step, and undo puts back exactly what was there, redo the recall', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const changed = scramble(ids.project, ids);
    let doc = changed;
    const history = new History({ get: () => doc, set: (next) => void (doc = next) });
    expect(history.transact('Recall Verse', (d) => void recallSnapshot(d, snap))).toBe(true);
    expect(history.steps().done).toHaveLength(1);
    expect(doc.mixer.inserts).toEqual(ids.project.mixer.inserts);
    history.undo();
    expect(doc).toEqual(changed);
    history.redo();
    expect(doc.mixer.inserts).toEqual(ids.project.mixer.inserts);
  });

  it('recalling the state the mix already has changes nothing (so it adds no undo step)', () => {
    const { project } = mix();
    const snap = captureSnapshot(project, 'Same', 1, { routing: true });
    expect(produce(project, (d) => void recallSnapshot(d, snap))).toBe(project);
  });

  it('writes straight to the tracks: a group link does not move the others', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const changed = produce(ids.project, (d) => {
      setInsertProp(d, ids.a, 'volume', 0.1);
      setInsertProp(d, ids.c, 'volume', 0.9);
    });
    const recalled = produce(changed, (d) => void recallSnapshot(d, snap));
    expect(recalled.mixer.inserts[ids.a]!.volume).toBe(0.8);
    expect(recalled.mixer.inserts[ids.c]!.volume).toBe(1);
  });

  it('leaves a track made after the snapshot alone and skips one deleted since', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const later = produce(ids.project, (d) => {
      addInsert(d, makeInsert('ins_new' as InsertId, 'Pad'), 1);
      setInsertProp(d, 'ins_new' as InsertId, 'volume', 0.33);
      removeInsert(d, ids.b);
    });
    let report!: ReturnType<typeof recallSnapshot>;
    const recalled = produce(later, (d) => void (report = recallSnapshot(d, snap)));
    expect(recalled.mixer.inserts['ins_new' as InsertId]!.volume).toBe(0.33);
    expect(report.skipped).toEqual(['Reverb was deleted since']);
    expect(recalled.mixer.inserts[ids.a]!.volume).toBe(0.8);
  });

  it('keeps the parameters of an effect that was replaced by another one in the slot', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const swapped = produce(ids.project, (d) => {
      const slot = d.mixer.inserts[ids.a]!.fx[0]!;
      slot.plugin = makePluginInstance('test.other', 1, { gain: 99 });
    });
    const recalled = produce(swapped, (d) => void recallSnapshot(d, snap));
    expect(recalled.mixer.inserts[ids.a]!.fx[0]!.plugin.params).toEqual({ gain: 99 });
  });

  it('puts back routing when saved with it, in order, and never makes a loop', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Routed', 1, { routing: true });
    const rerouted = produce(ids.project, (d) => {
      clearRoutes(d, ids.a);
      setRoute(d, ids.b, ids.c, {});
      setRoute(d, ids.c, ids.a, {});
      setSlotSidechain(d, ids.b, ids.slotB, ids.a);
    });
    const recalled = produce(rerouted, (d) => void recallSnapshot(d, snap));
    expect(recalled.mixer.inserts[ids.a]!.routes).toEqual(ids.project.mixer.inserts[ids.a]!.routes);
    expect(recalled.mixer.inserts[ids.b]!.fx[0]!.sidechain).toBeNull();
    const without = produce(rerouted, (d) => void recallSnapshot(d, snap, { routing: false }));
    expect(without.mixer.inserts[ids.a]!.routes).toEqual([]);
  });

  it('does not touch routing when the snapshot was saved without it', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Levels only', 1);
    const rerouted = produce(ids.project, (d) => clearRoutes(d, ids.a));
    expect(produce(rerouted, (d) => void recallSnapshot(d, snap)).mixer.inserts[ids.a]!.routes).toEqual([]);
  });

  it('never changes notes, patterns or the playlist', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const changed = scramble(ids.project, ids);
    const recalled = produce(changed, (d) => void recallSnapshot(d, snap));
    expect(recalled.channels).toBe(changed.channels);
    expect(recalled.patterns).toBe(changed.patterns);
    expect(recalled.playlist).toBe(changed.playlist);
  });
});

describe('diff', () => {
  it('says nothing when the mix matches the snapshot', () => {
    const { project } = mix();
    expect(diffAgainstCurrent(project, captureSnapshot(project, 'A', 1, { routing: true }), plugins)).toEqual([]);
  });

  it('lists what recalling would change, in words with units', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const changed = scramble(ids.project, ids);
    const lines = diffAgainstCurrent(changed, snap, plugins).map((line) => line.text);
    expect(lines).toEqual([
      'Master: fader -8.0 dB → 0.0 dB',
      'Kick: fader -14.0 dB → -1.9 dB',
      'Kick: send to Reverb -20.0 dB → -6.0 dB',
      'Kick · EQ: bypassed → on',
      'Kick · EQ: Gain -9.0 dB → +3.0 dB',
      'Reverb: fader +3.5 dB → 0.0 dB',
      'Reverb: soloed → not soloed',
      'Reverb · EQ: dry/wet 25% → 100%',
      'Reverb · EQ: Gain +7.0 dB → -2.0 dB',
      'Insert 3: pan 90% right → centre',
      'Insert 3: muted → playing',
      'VCA of Drums: -10.5 dB → -0.9 dB',
    ]);
  });

  it('names tracks made or deleted since, and effects too', () => {
    const ids = mix();
    const snap = captureSnapshot(ids.project, 'Verse', 1);
    const later = produce(ids.project, (d) => {
      removeInsert(d, ids.b);
      addFxSlot(d, ids.a, makePluginInstance('test.eq', 1, {}));
    });
    const lines = diffAgainstCurrent(later, snap, plugins).map((line) => line.text);
    expect(lines).toContain('Reverb: deleted since (its saved settings are skipped)');
    expect(lines).toContain('Kick · EQ: added since the snapshot (left as it is)');
  });

  it('compares two snapshots', () => {
    const ids = mix();
    const a = captureSnapshot(ids.project, 'A', 1);
    const b = captureSnapshot(scramble(ids.project, ids), 'B', 2);
    const lines = diffBetween(ids.project, a, b, plugins).map((line) => line.text);
    expect(lines).toContain('Kick: fader -1.9 dB → -14.0 dB');
    expect(diffBetween(ids.project, a, a, plugins)).toEqual([]);
  });
});

describe('the list of snapshots', () => {
  it('adds, renames, updates and deletes; the field goes with the last one', () => {
    const ids = mix();
    const first = captureSnapshot(ids.project, 'Verse', 1, { id: 'snap_a' as never });
    let doc = produce(ids.project, (d) => void addSnapshot(d, first));
    expect(doc.mixSnapshots).toHaveLength(1);
    doc = produce(doc, (d) => renameSnapshot(d, first.id, '  Chorus  '));
    expect(doc.mixSnapshots![0]!.name).toBe('Chorus');
    doc = produce(doc, (d) => renameSnapshot(d, first.id, '   '));
    expect(doc.mixSnapshots![0]!.name).toBe('Chorus');
    const louder = scramble(ids.project, ids);
    doc = produce(doc, (d) => replaceSnapshotState(d, first.id, captureSnapshot(louder, 'ignored', 9)));
    expect(doc.mixSnapshots![0]).toMatchObject({ id: 'snap_a', name: 'Chorus', savedAt: 9 });
    expect(doc.mixSnapshots![0]!.inserts[ids.a]!.volume).toBe(0.2);
    doc = produce(doc, (d) => deleteSnapshot(d, first.id));
    expect('mixSnapshots' in doc).toBe(false);
  });

  it('names new snapshots by the first free number', () => {
    expect(freeSnapshotName(undefined)).toBe('Snapshot 1');
    const { project } = mix();
    const snapshots = [captureSnapshot(project, 'Snapshot 2', 1), captureSnapshot(project, 'Snapshot 1', 1)];
    expect(freeSnapshotName(snapshots)).toBe('Snapshot 3');
  });
});
