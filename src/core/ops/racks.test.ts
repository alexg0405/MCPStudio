import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { MACRO_COUNT, MAX_BRANCH_FX, RACK_PLUGIN_ID, isRackSlot, makeRackPlugin } from '../model/rack';
import type { BranchId, InsertId, Project, Rack, SlotId } from '../model/types';
import { pluginInstanceOf } from '../query/mixer';
import { allSlots, audibleBranches, locateSlot } from '../query/rack';
import { History } from '../history/history';
import { addFxSlot, removeFxSlot } from './mixer';
import { setPluginParam } from './channels';
import { captureSnapshot } from '../snapshots/capture';
import { recallSnapshot } from '../snapshots/recall';
import {
  addBranch,
  addRackFx,
  addRackSlot,
  clearMacro,
  groupIntoRack,
  moveBranch,
  moveRackFx,
  moveSlotIntoRack,
  moveSlotOutOfRack,
  removeBranch,
  removeMacroMapping,
  removeRackFx,
  renameMacro,
  setBranch,
  setCrossover,
  setMacroMapping,
  setRackSplit,
  ungroupRack,
} from './racks';

beforeEach(() => setIdSource(seededBytes(5)));

const effect = (id: string) => makePluginInstance(id, 1, { amount: 0.5 });

/** An empty project, its first insert, and a rack on it (one branch). */
function withRack() {
  const empty = createEmptyProject({ now: new Date(0) });
  const insertId = empty.mixer.order[1] as InsertId;
  let rackId!: SlotId;
  const project = produce(empty, (d) => {
    rackId = addRackSlot(d, insertId)!;
  });
  return { project, insertId, rackId };
}

const rackOf = (project: Project, insertId: InsertId, rackId: SlotId): Rack => {
  const slot = project.mixer.inserts[insertId]!.fx.find((s) => s.id === rackId)!;
  expect(isRackSlot(slot)).toBe(true);
  return slot.rack!;
};

describe('making a rack', () => {
  it('a new rack is one empty branch, eight unmapped macros and the rack plugin at its defaults', () => {
    const { project, insertId, rackId } = withRack();
    const slot = project.mixer.inserts[insertId]!.fx[0]!;
    expect(slot.id).toBe(rackId);
    expect(slot.plugin).toEqual(makeRackPlugin());
    expect(slot.plugin.pluginId).toBe(RACK_PLUGIN_ID);
    const rack = slot.rack!;
    expect(rack.split).toBe('parallel');
    expect(rack.branches).toHaveLength(1);
    expect(rack.branches[0]).toMatchObject({ name: 'Chain', levelDb: 0, pan: 0, muted: false, solo: false, fx: [] });
    expect(rack.macros).toHaveLength(MACRO_COUNT);
    expect(rack.macros.every((m) => m.mappings.length === 0)).toBe(true);
    expect(rack.macros[0]!.name).toBe('Macro 1');
  });

  it('groups chosen effects into one branch in their order, keeping their ids, and ungroups them again', () => {
    const empty = createEmptyProject({ now: new Date(0) });
    const insertId = empty.mixer.order[1] as InsertId;
    const ids: SlotId[] = [];
    const base = produce(empty, (d) => {
      for (const name of ['test.a', 'test.b', 'test.c', 'test.d']) ids.push(addFxSlot(d, insertId, effect(name))!);
    });
    let rackId!: SlotId;
    const grouped = produce(base, (d) => {
      const result = groupIntoRack(d, insertId, [ids[3]!, ids[1]!]);
      expect(result.ok).toBe(true);
      rackId = result.slotId!;
    });
    const fx = grouped.mixer.inserts[insertId]!.fx;
    expect(fx.map((s) => s.id)).toEqual([ids[0], rackId, ids[2]]);
    expect(rackOf(grouped, insertId, rackId).branches[0]!.fx.map((s) => s.id)).toEqual([ids[1], ids[3]]);
    expect(locateSlot(grouped.mixer.inserts[insertId], ids[3]!)?.rackSlot?.id).toBe(rackId);
    const apart = produce(grouped, (d) => void expect(ungroupRack(d, insertId, rackId)).toEqual({ ok: true }));
    expect(apart.mixer.inserts[insertId]!.fx.map((s) => s.id)).toEqual([ids[0], ids[1], ids[3], ids[2]]);
  });

  it('refuses to group a rack, an effect with a sidechain, nothing, or more than a branch holds', () => {
    const { project, insertId, rackId } = withRack();
    const ids: SlotId[] = [];
    const base = produce(project, (d) => {
      for (let i = 0; i < 9; i++) ids.push(addFxSlot(d, insertId, effect('test.x'))!);
      d.mixer.inserts[insertId]!.fx.find((s) => s.id === ids[0])!.sidechain = d.mixer.order[2] as InsertId;
    });
    produce(base, (d) => {
      expect(groupIntoRack(d, insertId, [rackId]).ok).toBe(false);
      expect(groupIntoRack(d, insertId, [ids[0]!]).ok).toBe(false);
      expect(groupIntoRack(d, insertId, []).ok).toBe(false);
      d.mixer.inserts[insertId]!.fx.find((slot) => slot.id === ids[0])!.sidechain = null;
      expect(groupIntoRack(d, insertId, ids.slice(1)).ok).toBe(true);
    });
    produce(base, (d) => {
      d.mixer.inserts[insertId]!.fx.find((slot) => slot.id === ids[0])!.sidechain = null;
      expect(groupIntoRack(d, insertId, ids)).toEqual({ ok: false, reason: `A branch holds at most ${MAX_BRANCH_FX} effects.` });
    });
  });

  it('refuses a rack inside a rack and an eleventh slot', () => {
    const { project, insertId, rackId } = withRack();
    const branch = rackOf(project, insertId, rackId).branches[0]!.id;
    produce(project, (d) => {
      expect(addRackFx(d, insertId, rackId, branch, makeRackPlugin())).toBeNull();
      for (let i = 0; i < 9; i++) expect(addFxSlot(d, insertId, effect('test.x'))).not.toBeNull();
      expect(addRackSlot(d, insertId)).toBeNull();
    });
  });
});

describe('the split, branches and crossovers', () => {
  it('changes the split: names, counts and crossovers follow', () => {
    const { project, insertId, rackId } = withRack();
    const bands = produce(project, (d) => void setRackSplit(d, insertId, rackId, 'bands'));
    expect(rackOf(bands, insertId, rackId).branches.map((b) => b.name)).toEqual(['Low', 'High']);
    expect(rackOf(bands, insertId, rackId).crossovers).toEqual([500]);
    const midSide = produce(bands, (d) => void setRackSplit(d, insertId, rackId, 'midside'));
    expect(rackOf(midSide, insertId, rackId).branches.map((b) => b.name)).toEqual(['Mid', 'Side']);
    expect(rackOf(midSide, insertId, rackId).crossovers).toEqual([]);
    const back = produce(midSide, (d) => void setRackSplit(d, insertId, rackId, 'parallel'));
    expect(rackOf(back, insertId, rackId).branches.map((b) => b.name)).toEqual(['Branch 1', 'Branch 2']);
  });

  it('adds bands from the top and merges them again, moving the crossovers and their mappings with them', () => {
    const { project, insertId, rackId } = withRack();
    let lowId!: BranchId;
    const three = produce(project, (d) => {
      setRackSplit(d, insertId, rackId, 'bands');
      expect(addBranch(d, insertId, rackId)).not.toBeNull();
      lowId = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches[0]!.id;
      expect(setMacroMapping(d, insertId, rackId, 0, { target: { kind: 'crossover', index: 1 }, min: 2000, max: 6000, curve: 'linear' })).toBe(true);
    });
    const rack = rackOf(three, insertId, rackId);
    expect(rack.branches.map((b) => b.name)).toEqual(['Low', 'Mid', 'High']);
    expect(rack.crossovers).toHaveLength(2);
    expect(rack.crossovers[1]).toBeGreaterThan(rack.crossovers[0]!);
    const merged = produce(three, (d) => void expect(removeBranch(d, insertId, rackId, lowId)).toBe(true));
    const after = rackOf(merged, insertId, rackId);
    expect(after.branches.map((b) => b.name)).toEqual(['Low', 'High']);
    expect(after.crossovers).toHaveLength(1);
    expect(after.macros[0]!.mappings[0]!.target).toEqual({ kind: 'crossover', index: 0 });
    produce(merged, (d) => {
      const only = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches[0]!.id;
      expect(removeBranch(d, insertId, rackId, only)).toBe(false);
    });
  });

  it('keeps the branch count of mid/side and left/right at two, and the order of bands', () => {
    const { project, insertId, rackId } = withRack();
    produce(project, (d) => {
      setRackSplit(d, insertId, rackId, 'leftright');
      expect(addBranch(d, insertId, rackId)).toBeNull();
      const first = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches[0]!.id;
      expect(moveBranch(d, insertId, rackId, first, 1)).toBe(false);
      setRackSplit(d, insertId, rackId, 'parallel');
      expect(moveBranch(d, insertId, rackId, first, 1)).toBe(true);
      expect(d.mixer.inserts[insertId]!.fx[0]!.rack!.branches[1]!.id).toBe(first);
    });
  });

  it('sets a branch (clamped) and keeps crossovers apart', () => {
    const { project, insertId, rackId } = withRack();
    const done = produce(project, (d) => {
      setRackSplit(d, insertId, rackId, 'bands');
      addBranch(d, insertId, rackId);
      const id = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches[1]!.id;
      expect(setBranch(d, insertId, rackId, id, { levelDb: -99, pan: 3, muted: true, name: '  Body  ' })).toBe(true);
      expect(setCrossover(d, insertId, rackId, 0, 100000)).toBe(true);
    });
    const rack = rackOf(done, insertId, rackId);
    expect(rack.branches[1]).toMatchObject({ levelDb: -60, pan: 1, muted: true, name: 'Body' });
    expect(rack.crossovers[0]).toBeLessThan(rack.crossovers[1]!);
    expect(rack.crossovers[1]! / rack.crossovers[0]!).toBeGreaterThanOrEqual(1.05 - 1e-9);
  });

  it('mute and solo decide which branches sound', () => {
    const { project, insertId, rackId } = withRack();
    const rack = produce(project, (d) => {
      setRackSplit(d, insertId, rackId, 'parallel');
      addBranch(d, insertId, rackId);
      const [a, b] = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches.map((x) => x.id);
      setBranch(d, insertId, rackId, a!, { muted: true });
      expect(b).toBeDefined();
    });
    const r = rackOf(rack, insertId, rackId);
    expect([...audibleBranches(r)]).toEqual([r.branches[1]!.id]);
    const soloed = produce(rack, (d) => void setBranch(d, insertId, rackId, r.branches[0]!.id, { solo: true }));
    expect([...audibleBranches(rackOf(soloed, insertId, rackId))]).toEqual([r.branches[0]!.id]);
  });
});

describe('effects inside a rack', () => {
  function withEffects() {
    const { project, insertId, rackId } = withRack();
    const ids: SlotId[] = [];
    let second!: BranchId;
    const done = produce(project, (d) => {
      addBranch(d, insertId, rackId);
      const [first, other] = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches.map((b) => b.id);
      second = other!;
      ids.push(addRackFx(d, insertId, rackId, first!, effect('test.a'))!);
      ids.push(addRackFx(d, insertId, rackId, first!, effect('test.b'))!);
      ids.push(addRackFx(d, insertId, rackId, second, effect('test.c'))!);
    });
    return { project: done, insertId, rackId, ids, second };
  }

  it('finds an inner effect like any slot: its plugin, parameters and the controllers on it', () => {
    const { project, insertId, ids } = withEffects();
    expect(allSlots(project.mixer.inserts[insertId]!).map((s) => s.id)).toContain(ids[2]);
    const owner = { kind: 'fx' as const, insertId, slotId: ids[2]! };
    expect(pluginInstanceOf(project, owner)?.pluginId).toBe('test.c');
    const edited = produce(project, (d) => void setPluginParam(d, owner, 'amount', 0.9));
    expect(pluginInstanceOf(edited, owner)?.params.amount).toBe(0.9);
    expect(pluginInstanceOf(project, owner)?.params.amount).toBe(0.5);
  });

  it('moves an effect to another branch and keeps its mappings; removes one and drops them', () => {
    const { project, insertId, rackId, ids, second } = withEffects();
    const mapped = produce(project, (d) => {
      expect(setMacroMapping(d, insertId, rackId, 2, { target: { kind: 'param', slotId: ids[0]!, paramId: 'amount' }, min: 0, max: 1, curve: 'linear' })).toBe(true);
      expect(setMacroMapping(d, insertId, rackId, 2, { target: { kind: 'mix', slotId: ids[1]! }, min: 0, max: 1, curve: 'linear' })).toBe(true);
    });
    const moved = produce(mapped, (d) => void expect(moveRackFx(d, insertId, ids[0]!, second, 0)).toBe(true));
    const rack = rackOf(moved, insertId, rackId);
    expect(rack.branches[1]!.fx.map((s) => s.id)).toEqual([ids[0], ids[2]]);
    expect(rack.macros[2]!.mappings).toHaveLength(2);
    const removed = produce(moved, (d) => void expect(removeRackFx(d, insertId, ids[0]!)).toBe(true));
    const after = rackOf(removed, insertId, rackId);
    expect(after.macros[2]!.mappings.map((m) => m.target.kind)).toEqual(['mix']);
    expect(locateSlot(removed.mixer.inserts[insertId], ids[0]!)).toBeUndefined();
  });

  it('moves an effect into a rack and out of it; removing the rack takes its effects with it', () => {
    const { project, insertId, rackId, ids } = withEffects();
    let outer!: SlotId;
    const added = produce(project, (d) => {
      outer = addFxSlot(d, insertId, effect('test.outer'))!;
    });
    const branch = rackOf(added, insertId, rackId).branches[0]!.id;
    const inside = produce(added, (d) => void expect(moveSlotIntoRack(d, insertId, outer, rackId, branch, 0)).toEqual({ ok: true }));
    expect(rackOf(inside, insertId, rackId).branches[0]!.fx[0]!.id).toBe(outer);
    expect(inside.mixer.inserts[insertId]!.fx.map((s) => s.id)).toEqual([rackId]);
    const out = produce(inside, (d) => void expect(moveSlotOutOfRack(d, insertId, ids[2]!)).toEqual({ ok: true }));
    expect(out.mixer.inserts[insertId]!.fx.map((s) => s.id)).toEqual([rackId, ids[2]]);
    const gone = produce(out, (d) => void removeFxSlot(d, insertId, rackId));
    expect(allSlots(gone.mixer.inserts[insertId]!).map((s) => s.id)).toEqual([ids[2]]);
  });
});

describe('macros', () => {
  it('renames a macro, maps targets, lets one macro own each target and clears', () => {
    const { project, insertId, rackId } = withRack();
    const branch = rackOf(project, insertId, rackId).branches[0]!.id;
    const done = produce(project, (d) => {
      expect(renameMacro(d, insertId, rackId, 0, '  Throw  ')).toBe(true);
      expect(renameMacro(d, insertId, rackId, 8, 'x')).toBe(false);
      const level = { target: { kind: 'branch', branchId: branch, param: 'level' } as const, min: -30, max: 0, curve: 'linear' as const };
      expect(setMacroMapping(d, insertId, rackId, 0, level)).toBe(true);
      expect(setMacroMapping(d, insertId, rackId, 1, level)).toBe(true);
      expect(setMacroMapping(d, insertId, rackId, 1, { target: { kind: 'gain' }, min: -12, max: 0, curve: 'inverted' })).toBe(true);
      expect(setMacroMapping(d, insertId, rackId, 1, { target: { kind: 'branch', branchId: 'br_nope' as BranchId, param: 'pan' }, min: 0, max: 1, curve: 'linear' })).toBe(false);
      expect(setMacroMapping(d, insertId, rackId, 1, { target: { kind: 'gain' }, min: Number.NaN, max: 0, curve: 'linear' })).toBe(false);
    });
    const macros = rackOf(done, insertId, rackId).macros;
    expect(macros[0]!.name).toBe('Throw');
    expect(macros[0]!.mappings).toEqual([]);
    expect(macros[1]!.mappings.map((m) => m.target.kind)).toEqual(['branch', 'gain']);
    const trimmed = produce(done, (d) => {
      expect(removeMacroMapping(d, insertId, rackId, 1, { kind: 'gain' })).toBe(true);
      expect(removeMacroMapping(d, insertId, rackId, 1, { kind: 'gain' })).toBe(false);
    });
    expect(rackOf(trimmed, insertId, rackId).macros[1]!.mappings).toHaveLength(1);
    const cleared = produce(trimmed, (d) => void clearMacro(d, insertId, rackId, 1));
    expect(rackOf(cleared, insertId, rackId).macros[1]!.mappings).toEqual([]);
  });

  it('clamps a mapping range to what the target can be', () => {
    const { project, insertId, rackId } = withRack();
    const branch = rackOf(project, insertId, rackId).branches[0]!.id;
    const done = produce(project, (d) => {
      setMacroMapping(d, insertId, rackId, 0, { target: { kind: 'branch', branchId: branch, param: 'level' }, min: -200, max: 40, curve: 'linear' });
    });
    expect(rackOf(done, insertId, rackId).macros[0]!.mappings[0]).toMatchObject({ min: -60, max: 6 });
  });
});

describe('undo and snapshots', () => {
  it('every rack edit is one undo step', () => {
    const { project, insertId, rackId } = withRack();
    let doc = project;
    const history = new History({ get: () => doc, set: (next) => void (doc = next) });
    const branch = rackOf(doc, insertId, rackId).branches[0]!.id;
    history.transact('Add effect', (d) => void addRackFx(d, insertId, rackId, branch, effect('test.a')));
    const effectId = rackOf(doc, insertId, rackId).branches[0]!.fx[0]!.id;
    history.transact('Map macro', (d) => {
      setMacroMapping(d, insertId, rackId, 0, { target: { kind: 'param', slotId: effectId, paramId: 'amount' }, min: 0, max: 1, curve: 'linear' });
      renameMacro(d, insertId, rackId, 0, 'Drive');
    });
    history.transact('Split', (d) => void setRackSplit(d, insertId, rackId, 'midside'));
    const stages = [rackOf(doc, insertId, rackId).split];
    history.undo();
    stages.push(rackOf(doc, insertId, rackId).split);
    history.undo();
    expect(rackOf(doc, insertId, rackId).macros[0]).toMatchObject({ name: 'Macro 1', mappings: [] });
    history.undo();
    expect(rackOf(doc, insertId, rackId).branches[0]!.fx).toEqual([]);
    history.redo();
    history.redo();
    history.redo();
    expect(stages).toEqual(['midside', 'parallel']);
    expect(rackOf(doc, insertId, rackId).split).toBe('midside');
    expect(rackOf(doc, insertId, rackId).macros[0]!.name).toBe('Drive');
  });

  it('a snapshot keeps the macros, the inner effects and the branch settings, and recalls them in one step', () => {
    const { project, insertId, rackId } = withRack();
    let effectId!: SlotId;
    let branchId!: BranchId;
    const base = produce(project, (d) => {
      branchId = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches[0]!.id;
      effectId = addRackFx(d, insertId, rackId, branchId, effect('test.a'))!;
      setPluginParam(d, { kind: 'fx', insertId, slotId: rackId }, 'macro3', 0.25);
      setPluginParam(d, { kind: 'fx', insertId, slotId: effectId }, 'amount', 0.1);
      setBranch(d, insertId, rackId, branchId, { levelDb: -6, pan: 0.5 });
    });
    const snapshot = captureSnapshot(base, 'Verse', 0);
    expect(snapshot.inserts[insertId]!.fx[effectId]!.params.amount).toBe(0.1);
    expect(snapshot.inserts[insertId]!.fx[rackId]!.params.macro3).toBe(0.25);
    expect(snapshot.inserts[insertId]!.fx[rackId]!.rack!.branches[branchId]).toMatchObject({ levelDb: -6, pan: 0.5 });
    const changed = produce(base, (d) => {
      setPluginParam(d, { kind: 'fx', insertId, slotId: rackId }, 'macro3', 1);
      setPluginParam(d, { kind: 'fx', insertId, slotId: effectId }, 'amount', 0.9);
      setBranch(d, insertId, rackId, branchId, { levelDb: 0, pan: -1, muted: true });
    });
    let doc = changed;
    const history = new History({ get: () => doc, set: (next) => void (doc = next) });
    history.transact('Recall', (d) => void recallSnapshot(d, snapshot));
    expect(pluginInstanceOf(doc, { kind: 'fx', insertId, slotId: effectId })!.params.amount).toBe(0.1);
    expect(pluginInstanceOf(doc, { kind: 'fx', insertId, slotId: rackId })!.params.macro3).toBe(0.25);
    expect(rackOf(doc, insertId, rackId).branches[0]).toMatchObject({ levelDb: -6, pan: 0.5, muted: false });
    history.undo();
    expect(doc).toEqual(changed);
  });
});
