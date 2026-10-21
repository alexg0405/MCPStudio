import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { p } from '@agstudio/sdk/params';
import { createEmptyProject, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { RACK_PLUGIN_ID, isRackSlot, makeRackSlot } from '../model/rack';
import type { FxSlot, InsertId, Project, SlotId } from '../model/types';
import { addBranch, addRackFx, addRackSlot, setBranch, setMacroMapping, setRackSplit } from '../ops/racks';
import { migrateProject, repairProject } from '../schema/migrate';
import type { JsonObject } from '../schema/json-values';
import { cloneSlotWithNewIds } from './clone';
import { RACK_FILE_FORMAT, rackFilePluginIds, rackFileToSlot, rackSlotToFile, readRackFile, writeRackFile } from './file';
import { curvePosition, isBentMapping, macroTargetValue, startingRange } from './mapping';

beforeEach(() => setIdSource(seededBytes(21)));

/** A project with a two-branch rack holding two effects and mappings to every kind of target. */
function busyProject() {
  const empty = createEmptyProject({ now: new Date(0) });
  const insertId = empty.mixer.order[1] as InsertId;
  let rackId!: SlotId;
  let first!: SlotId;
  let second!: SlotId;
  const project = produce(empty, (d) => {
    rackId = addRackSlot(d, insertId, { split: 'bands', branches: 3 })!;
    const rack = d.mixer.inserts[insertId]!.fx[0]!.rack!;
    const [low, mid] = rack.branches.map((branch) => branch.id);
    first = addRackFx(d, insertId, rackId, low!, makePluginInstance('test.a', 2, { amount: 0.3 }, { state: { x: 1 } }))!;
    second = addRackFx(d, insertId, rackId, mid!, makePluginInstance('test.b', 1, { drive: 6 }))!;
    setBranch(d, insertId, rackId, mid!, { levelDb: -3, solo: true });
    setMacroMapping(d, insertId, rackId, 0, { target: { kind: 'param', slotId: first, paramId: 'amount' }, min: 0, max: 1, curve: 'exponential' });
    setMacroMapping(d, insertId, rackId, 0, { target: { kind: 'mix', slotId: second }, min: 0.2, max: 1, curve: 'linear' });
    setMacroMapping(d, insertId, rackId, 3, { target: { kind: 'crossover', index: 0 }, min: 100, max: 400, curve: 'linear' });
    setMacroMapping(d, insertId, rackId, 4, { target: { kind: 'branch', branchId: low!, param: 'level' }, min: -24, max: 0, curve: 'inverted' });
    setMacroMapping(d, insertId, rackId, 5, { target: { kind: 'gain' }, min: 0, max: -6, curve: 'linear' });
  });
  return { project, insertId, rackId, first, second };
}

const json = (project: Project) => JSON.parse(JSON.stringify(project)) as JsonObject;
const slotOf = (project: Project, insertId: InsertId): FxSlot => project.mixer.inserts[insertId]!.fx[0]!;

describe('macro maths', () => {
  const level = p.float(-60, 6, 0, { unit: 'dB', scale: 'db' });
  const cutoff = p.float(20, 20000, 1000, { unit: 'Hz', scale: 'log' });

  it('moves a linear parameter between its range ends, and backwards when inverted', () => {
    const map = { min: -30, max: 0, curve: 'linear' as const };
    expect(macroTargetValue(level, map, 0)).toBeCloseTo(-30, 9);
    expect(macroTargetValue(level, map, 0.5)).toBeCloseTo(-15, 9);
    expect(macroTargetValue(level, map, 1)).toBeCloseTo(0, 9);
    expect(macroTargetValue(level, { ...map, curve: 'inverted' }, 0)).toBeCloseTo(0, 9);
    expect(macroTargetValue(level, { ...map, curve: 'inverted' }, 1)).toBeCloseTo(-30, 9);
    expect(macroTargetValue(level, { min: 0, max: -30, curve: 'linear' }, 0.25)).toBeCloseTo(-7.5, 9);
  });

  it('sweeps a frequency evenly in octaves, and an exponential curve starts slowly', () => {
    const sweep = { min: 100, max: 6400, curve: 'linear' as const };
    expect(macroTargetValue(cutoff, sweep, 0.5)).toBeCloseTo(800, 6);
    expect(macroTargetValue(cutoff, sweep, 0.25)).toBeCloseTo(100 * 64 ** 0.25, 6);
    const slow = macroTargetValue(level, { min: -60, max: 0, curve: 'exponential' }, 0.5);
    expect(slow).toBeLessThan(macroTargetValue(level, { min: -60, max: 0, curve: 'linear' }, 0.5));
    expect(curvePosition('exponential', 0.5)).toBe(0.25);
    expect(curvePosition('linear', 2)).toBe(1);
    expect(curvePosition('linear', Number.NaN)).toBe(0);
  });

  it('stays inside the parameter range and rounds whole-number and option parameters', () => {
    const wide = { min: -500, max: 500, curve: 'linear' as const };
    expect(macroTargetValue(level, wide, 0)).toBe(-60);
    expect(macroTargetValue(level, wide, 1)).toBe(6);
    const steps = p.int(1, 9, 3);
    expect(macroTargetValue(steps, { min: 1, max: 9, curve: 'linear' }, 0.5)).toBe(5);
    expect(Number.isInteger(macroTargetValue(steps, { min: 1, max: 9, curve: 'linear' }, 0.33))).toBe(true);
    const shape = p.enum(['sine', 'saw', 'square'] as const, 'sine');
    expect(macroTargetValue(shape, { min: 0, max: 2, curve: 'linear' }, 1)).toBe(2);
    expect(macroTargetValue(shape, { min: 0, max: 2, curve: 'linear' }, 0.5)).toBe(1);
    const toggle = p.bool(false);
    expect(macroTargetValue(toggle, { min: 0, max: 1, curve: 'linear' }, 0.4)).toBe(0);
    expect(macroTargetValue(toggle, { min: 0, max: 1, curve: 'linear' }, 0.6)).toBe(1);
  });

  it('knows when a ramp has to be split into pieces, and starts a new mapping where the parameter is', () => {
    expect(isBentMapping(level, 'linear')).toBe(false);
    expect(isBentMapping(level, 'exponential')).toBe(true);
    expect(isBentMapping(cutoff, 'linear')).toBe(true);
    expect(isBentMapping(p.int(0, 4, 0), 'linear')).toBe(true);
    expect(startingRange(level, -6)).toEqual({ min: -6, max: -60 });
    expect(startingRange(level, -60)).toEqual({ min: -60, max: 6 });
    expect(startingRange(p.bool(false), 0)).toEqual({ min: 0, max: 1 });
  });
});

describe('repair of racks', () => {
  it('a healthy rack survives migrate and repair unchanged and silently, and repair is idempotent', () => {
    const { project } = busyProject();
    const { project: migrated } = migrateProject(json(project));
    const { project: repaired, repairs } = repairProject(migrated);
    expect(repairs).toEqual([]);
    expect(repaired).toEqual(project);
    expect(repairProject(repaired).repairs).toEqual([]);
  });

  it('a project with no racks has no rack data at all', () => {
    const { project } = repairProject(migrateProject(createEmptyProject({ now: new Date(0) })).project);
    expect(JSON.stringify(project)).not.toContain('"rack"');
  });

  /** The first slot of the first insert after `damage`, repaired. */
  function repairedSlot(damage: (slot: JsonObject, insert: JsonObject) => void) {
    const { project, insertId } = busyProject();
    const doc = json(project);
    const insert = (doc.mixer as JsonObject).inserts as JsonObject;
    const target = insert[insertId] as JsonObject;
    damage((target.fx as JsonObject[])[0]!, target);
    const result = repairProject(migrateProject(doc).project);
    return { slot: slotOf(result.project, insertId), repairs: result.repairs, project: result.project, insertId };
  }

  it('gives a rack with unusable contents an empty one, and drops a rack from an effect that is not one', () => {
    const broken = repairedSlot((slot) => void (slot.rack = 'oops'));
    expect(isRackSlot(broken.slot)).toBe(true);
    expect(broken.slot.rack!.branches).toHaveLength(1);
    expect(broken.repairs.join('\n')).toMatch(/empty rack/);
    const stray = repairedSlot((slot) => void ((slot.plugin as JsonObject).pluginId = 'test.not-a-rack'));
    expect(stray.slot.rack).toBeUndefined();
    expect(stray.repairs.join('\n')).toMatch(/Removed the rack data/);
  });

  it('puts back the number of branches a split takes, crossovers in order, and the eight macros', () => {
    const fixed = repairedSlot((slot) => {
      const rack = slot.rack as JsonObject;
      rack.split = 'midside';
      rack.crossovers = [9, 'x'];
      rack.macros = [{ name: '', mappings: 'no' }];
    });
    const rack = fixed.slot.rack!;
    expect(rack.branches).toHaveLength(2);
    expect(rack.crossovers).toEqual([]);
    expect(rack.macros).toHaveLength(8);
    expect(rack.macros[0]).toEqual({ name: 'Macro 1', mappings: [] });
    const bands = repairedSlot((slot) => {
      (slot.rack as JsonObject).crossovers = [5000, 100];
    });
    const edges = bands.slot.rack!.crossovers;
    expect(edges).toHaveLength(2);
    expect(edges[1]! / edges[0]!).toBeGreaterThanOrEqual(1.05 - 1e-9);
    expect(bands.repairs.join('\n')).toMatch(/crossovers/);
  });

  it('removes a nested rack, an unusable effect and a sidechain inside a rack, and renames duplicate ids', () => {
    const { slot, repairs } = repairedSlot((rackSlot, insert) => {
      const rack = rackSlot.rack as { branches: { fx: JsonObject[] }[] };
      const [a, b] = rack.branches[0]!.fx.concat(rack.branches[1]!.fx);
      rack.branches[0]!.fx.push({ id: 'fx_nested', plugin: { pluginId: RACK_PLUGIN_ID, pluginVersion: 1, params: {} }, enabled: true, mix: 1, sidechain: null }, { id: 'fx_bad', plugin: 5 });
      a!.sidechain = (insert.id as string) === 'x' ? null : 'master';
      b!.id = a!.id;
      b!.mix = 7;
    });
    const rack = slot.rack!;
    const ids = rack.branches.flatMap((branch) => branch.fx.map((fx) => fx.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(rack.branches.flatMap((branch) => branch.fx).every((fx) => fx.sidechain === null && fx.mix <= 1)).toBe(true);
    expect(repairs.join('\n')).toMatch(/unusable effect/);
  });

  it('keeps only the mappings that point at something in the rack, one macro per target', () => {
    const { slot, repairs } = repairedSlot((rackSlot) => {
      const macros = (rackSlot.rack as { macros: { mappings: JsonObject[] }[] }).macros;
      const target = macros[0]!.mappings[0]!;
      macros[1]!.mappings.push({ ...target }, { target: { kind: 'param', slotId: 'fx_gone', paramId: 'a' }, min: 0, max: 1, curve: 'linear' }, { target: { kind: 'crossover', index: 7 }, min: 0, max: 1, curve: 'linear' }, { target: { kind: 'gain' }, min: Number.NaN, max: 1, curve: 'linear' }, { target: { kind: 'mix' }, min: 0, max: 1, curve: 'nope' });
    });
    const macros = slot.rack!.macros;
    expect(macros[0]!.mappings).toHaveLength(2);
    expect(macros[1]!.mappings).toEqual([]);
    expect(repairs.join('\n')).toMatch(/macro mapping/);
  });
});

describe('copies and files', () => {
  it('a copy has new ids all through and its mappings point at them', () => {
    const { project, insertId } = busyProject();
    const original = slotOf(project, insertId);
    const copy = cloneSlotWithNewIds(original);
    const idsOf = (slot: FxSlot) => [slot.id, ...slot.rack!.branches.flatMap((b) => [b.id, ...b.fx.map((f) => f.id)])];
    expect(idsOf(copy).filter((id) => idsOf(original).includes(id))).toEqual([]);
    const mapped = copy.rack!.macros[0]!.mappings[0]!.target;
    expect(mapped.kind === 'param' && copy.rack!.branches[0]!.fx[0]!.id === mapped.slotId).toBe(true);
    const level = copy.rack!.macros[4]!.mappings[0]!.target;
    expect(level.kind === 'branch' && level.branchId === copy.rack!.branches[0]!.id).toBe(true);
    expect(copy.rack!.macros[3]!.mappings[0]!.target).toEqual({ kind: 'crossover', index: 0 });
  });

  it('writes a rack file and reads it back to the same rack, with fresh ids and no samples', () => {
    const { project, insertId } = busyProject();
    const slot = produce(slotOf(project, insertId), (d) => {
      d.plugin.samples = { main: 'smp_x' as never };
      d.rack!.branches[0]!.fx[0]!.plugin.samples = { main: 'smp_y' as never };
    });
    const file = rackSlotToFile(slot, '  Big sound  ', 'Parallel punch');
    const text = writeRackFile(file);
    expect(file.format).toBe(RACK_FILE_FORMAT);
    expect(text).not.toContain('smp_');
    const read = readRackFile(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.notes).toEqual([]);
    expect(read.file.name).toBe('Big sound');
    expect(read.file.description).toBe('Parallel punch');
    expect(rackFilePluginIds(read.file).sort()).toEqual(['test.a', 'test.b']);
    const copy = rackFileToSlot(read.file);
    expect(copy.id).not.toBe(slot.id);
    expect(copy.rack.split).toBe('bands');
    expect(copy.rack.crossovers).toEqual(slot.rack!.crossovers);
    expect(copy.rack.macros.map((m) => m.mappings.length)).toEqual(slot.rack!.macros.map((m) => m.mappings.length));
    expect(copy.rack.branches[0]!.fx[0]!.plugin).toEqual({ pluginId: 'test.a', pluginVersion: 2, params: { amount: 0.3 }, state: { x: 1 } });
  });

  it('says in plain words why a file cannot be used', () => {
    const slot = makeRackSlot();
    const good = JSON.parse(writeRackFile(rackSlotToFile(slot, 'Empty'))) as JsonObject;
    const error = (value: unknown) => {
      const read = readRackFile(typeof value === 'string' ? value : JSON.stringify(value));
      return read.ok ? '' : read.error;
    };
    expect(error('not json')).toMatch(/not valid JSON/);
    expect(error({ hello: 1 })).toMatch(/not an AGstudio rack file/);
    expect(error({ ...good, version: 99 })).toMatch(/newer version/);
    expect(error({ ...good, name: '' })).toMatch(/no name/);
    expect(error({ ...good, slot: { plugin: { pluginId: 'test.a' } } })).toMatch(/does not hold a rack/);
    expect(error(good)).toBe('');
  });

  it('repairs small damage inside a file and says so', () => {
    const { project, insertId } = busyProject();
    const file = JSON.parse(writeRackFile(rackSlotToFile(slotOf(project, insertId), 'Busy'))) as JsonObject;
    ((file.slot as JsonObject).rack as JsonObject).crossovers = [];
    const read = readRackFile(JSON.stringify(file));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.notes.join('\n')).toMatch(/crossovers/);
      expect(read.file.slot.rack!.crossovers).toHaveLength(2);
    }
  });
});

describe('a rack with every split', () => {
  it('keeps its mappings valid through a change of split and branch count', () => {
    const { project, insertId, rackId } = busyProject();
    const changed = produce(project, (d) => {
      setRackSplit(d, insertId, rackId, 'parallel');
      addBranch(d, insertId, rackId);
    });
    const rack = slotOf(changed, insertId).rack!;
    // The crossover mapping is gone with the bands; the rest still points at things that exist.
    expect(rack.macros[3]!.mappings).toEqual([]);
    expect(rack.macros[0]!.mappings).toHaveLength(2);
  });
});
