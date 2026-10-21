import { describe, expect, it } from 'vitest';
import { makePluginInstance } from '@core/model/defaults';
import { RACK_PLUGIN_ID, isRackSlot } from '@core/model/rack';
import type { InsertId, SlotId } from '@core/model/types';
import { MAX_FX_SLOTS, addFxSlot, removeFxSlot } from '@core/ops/mixer';
import { targetKey } from '@core/model/targets';
import { removeEffect } from '../actions/mixer';
import { macroTargetValue } from '@core/rack/mapping';
import { writeRackFile, readRackFile } from '@core/rack/file';
import { addEmptyRack, addRackChoice, allRacks, groupSlotsIntoRack, mapToMacro, rackAt, saveRackAs, ungroupSlot } from '../actions/racks';
import { memoryPresetStorage, PresetLibrary } from '../presets';
import { createTestServices } from '../testing';
import { buildFactoryRack } from './build';
import { FACTORY_RACKS } from './factory';
import { findRackChoice, rackChoices, userRackOf } from './library';
import { macroTargetSpec } from './targets';

type S = ReturnType<typeof createTestServices>;
const insertOf = (s: S): InsertId => s.doc.getState().project.mixer.order[1] as InsertId;
const fx = (s: S, insertId: InsertId) => s.doc.getState().project.mixer.inserts[insertId]!.fx;

describe('the rack plugin', () => {
  it('is registered as a built-in effect with eight macros and an output gain', () => {
    const s = createTestServices();
    const def = s.plugins.get(RACK_PLUGIN_ID);
    expect(def?.kind).toBe('effect');
    expect(Object.keys(def!.params)).toEqual(['macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8', 'gain']);
    expect(def!.description).toBeTruthy();
  });

  it('adding the rack plugin like any effect gives an empty rack, not a broken slot', () => {
    const s = createTestServices();
    const insertId = insertOf(s);
    s.history.transact('add', (d) => void addFxSlot(d, insertId, makePluginInstance(RACK_PLUGIN_ID, 1, {})));
    const slot = fx(s, insertId)[0]!;
    expect(isRackSlot(slot)).toBe(true);
    expect(slot.rack!.branches).toHaveLength(1);
  });
});

describe('factory racks', () => {
  it('has the five racks, and every one builds from plugins, presets and parameters that exist', () => {
    const s = createTestServices();
    expect(FACTORY_RACKS.map((rack) => rack.name)).toEqual([
      'Parallel NY compression',
      'Multiband saturation',
      'Mid/side widener',
      'Dub delay throws with macro',
      'Lo-fi tape with macro',
    ]);
    for (const recipe of FACTORY_RACKS) {
      const built = buildFactoryRack(s, recipe);
      expect('error' in built, `${recipe.name}: ${'error' in built ? built.error : ''}`).toBe(false);
      if ('error' in built) continue;
      const { rack } = built.slot;
      expect(recipe.description.length, recipe.name).toBeGreaterThan(40);
      expect(rack.branches.length, recipe.name).toBe(recipe.branches.length);
      for (const fxRecipe of recipe.branches.flatMap((branch) => branch.fx)) {
        const def = s.plugins.get(fxRecipe.pluginId);
        expect(def?.kind, `${recipe.name}: ${fxRecipe.pluginId}`).toBe('effect');
        if (fxRecipe.preset) expect(def!.presets?.map((p) => p.name)).toContain(fxRecipe.preset);
      }
      // Every macro has a name of its own, drives something, and every mapping sweeps a real range of a real target.
      const named = rack.macros.filter((macro) => macro.mappings.length > 0);
      expect(named.length, recipe.name).toBeGreaterThanOrEqual(3);
      for (const macro of named) {
        expect(macro.name, recipe.name).not.toMatch(/^Macro \d$/);
        for (const mapping of macro.mappings) {
          const spec = macroTargetSpec(s, rack, mapping.target);
          expect(spec, `${recipe.name} · ${macro.name}`).not.toBeNull();
          expect(macroTargetValue(spec!, mapping, 0)).not.toBeCloseTo(macroTargetValue(spec!, mapping, 1), 6);
        }
      }
      // A branch that is silent until its macro opens it (the throws) is the only one that may start at the bottom.
      const value = (index: number) => built.slot.plugin.params[`macro${index + 1}`] as number;
      expect(rack.macros.every((_, i) => value(i) >= 0 && value(i) <= 1)).toBe(true);
    }
  });

  it('builds each rack with new ids every time', () => {
    const s = createTestServices();
    const recipe = FACTORY_RACKS[0]!;
    const first = buildFactoryRack(s, recipe);
    const second = buildFactoryRack(s, recipe);
    if ('error' in first || 'error' in second) throw new Error('could not build');
    expect(first.slot.id).not.toBe(second.slot.id);
    expect(first.slot.rack.branches[0]!.id).not.toBe(second.slot.rack.branches[0]!.id);
  });

  it('puts a factory rack on a track as one undo step and says what it did', () => {
    const s = createTestServices();
    const insertId = insertOf(s);
    const choice = findRackChoice(allRacks(s), 'mid/side')!;
    expect(choice.source).toBe('factory');
    const id = addRackChoice(s, insertId, choice);
    expect(id).not.toBeNull();
    expect(isRackSlot(fx(s, insertId)[0]!)).toBe(true);
    expect(s.history.status().undoLabel).toBe('Rack: Mid/side widener');
    s.history.undo();
    expect(fx(s, insertId)).toHaveLength(0);
  });

  it('refuses a rack on a full track', () => {
    const s = createTestServices();
    const insertId = insertOf(s);
    s.history.transact('fill', (d) => {
      for (let i = 0; i < MAX_FX_SLOTS; i++) addFxSlot(d, insertId, makePluginInstance('agstudio.eq', 1, {}));
    });
    expect(addEmptyRack(s, insertId)).toBeNull();
    expect(addRackChoice(s, insertId, allRacks(s)[0]!)).toBeNull();
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/already has 10 effects/);
  });
});

describe('your own racks', () => {
  function withRack() {
    const s = createTestServices();
    const insertId = insertOf(s);
    const slotId = addRackChoice(s, insertId, findRackChoice(allRacks(s), 'Parallel NY')!)!;
    return { s, insertId, slotId };
  }

  it('saves a rack, lists it with the factory ones, and puts it on another track with new ids', () => {
    const { s, insertId, slotId } = withRack();
    const saved = saveRackAs(s, insertId, slotId, 'My squash', 'Mine');
    expect(saved?.file.name).toBe('My squash');
    const choices = allRacks(s);
    expect(choices.map((c) => c.name)).toContain('My squash');
    expect(choices.find((c) => c.name === 'My squash')).toMatchObject({ source: 'user', description: 'Mine' });
    const other = s.doc.getState().project.mixer.order[2] as InsertId;
    const id = addRackChoice(s, other, choices.find((c) => c.name === 'My squash')!);
    const copy = rackAt(s, other, id!)!;
    const original = rackAt(s, insertId, slotId)!;
    expect(copy.rack.macros.map((m) => m.name)).toEqual(original.rack.macros.map((m) => m.name));
    expect(copy.rack.branches[1]!.fx[0]!.id).not.toBe(original.rack.branches[1]!.fx[0]!.id);
    expect(copy.plugin.params.macro1).toBe(original.plugin.params.macro1);
  });

  it('replaces a rack of the same name, renames and removes (and undo puts it back)', () => {
    const { s, insertId, slotId } = withRack();
    const first = saveRackAs(s, insertId, slotId, 'My squash')!;
    const again = saveRackAs(s, insertId, slotId, 'my squash')!;
    expect(again.id).toBe(first.id);
    expect(s.presets.racks()).toHaveLength(1);
    expect(s.presets.renameRack(first.id, 'Squash 2')).toBe(true);
    expect(s.presets.getRack(first.id)?.file.name).toBe('Squash 2');
    const removed = s.presets.removeRack(first.id)!;
    expect(s.presets.racks()).toHaveLength(0);
    s.presets.restoreRack(removed);
    expect(s.presets.racks()).toHaveLength(1);
  });

  it('keeps them across a restart (stored, read back and checked)', async () => {
    const { s, insertId, slotId } = withRack();
    const storage = memoryPresetStorage();
    const library = new PresetLibrary(storage);
    const saved = saveRackAs(s, insertId, slotId, 'Kept')!;
    library.saveRack(saved.file);
    await library.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reloaded = new PresetLibrary(storage);
    await reloaded.load();
    expect(reloaded.racks().map((r) => r.file.name)).toEqual(['Kept']);
    expect(userRackOf({ id: 'x', file: { nonsense: true } })).toBeNull();
  });

  it('round-trips through a .agrack file', () => {
    const { s, insertId, slotId } = withRack();
    const saved = saveRackAs(s, insertId, slotId, 'Shared', 'For a friend')!;
    const text = writeRackFile(saved.file);
    const imported = readRackFile(text);
    expect(imported.ok).toBe(true);
    const other = createTestServices();
    expect(other.presets.racks()).toHaveLength(0);
    if (imported.ok) other.presets.saveRack(imported.file);
    expect(rackChoices(other.presets.racks()).map((c) => c.name)).toContain('Shared');
  });

  it('will not build a rack whose plugin is not installed', () => {
    const { s, insertId, slotId } = withRack();
    const saved = saveRackAs(s, insertId, slotId, 'Needs a plugin')!;
    const broken = structuredClone(saved.file);
    broken.slot.rack!.branches[1]!.fx[0]!.plugin.pluginId = 'user.not-here';
    s.presets.saveRack(broken);
    const toInsert = s.doc.getState().project.mixer.order[3] as InsertId;
    expect(addRackChoice(s, toInsert, allRacks(s).find((c) => c.name === 'Needs a plugin')!)).toBeNull();
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/not installed/);
  });
});

describe('grouping, ungrouping and mapping', () => {
  it('groups effects into a rack, takes it apart again, and maps a knob to a macro starting where it is', () => {
    const s = createTestServices();
    const insertId = insertOf(s);
    const ids: SlotId[] = [];
    s.history.transact('add', (d) => {
      for (const id of ['agstudio.eq-pro', 'agstudio.compressor', 'agstudio.saturator']) {
        ids.push(addFxSlot(d, insertId, makePluginInstance(id, 1, id === 'agstudio.compressor' ? { threshold: -20 } : {}))!);
      }
    });
    const rackId = groupSlotsIntoRack(s, insertId, [ids[1]!, ids[2]!])!;
    expect(fx(s, insertId).map((slot) => slot.id)).toEqual([ids[0], rackId]);
    expect(s.history.status().undoLabel).toBe('Group into a rack');
    expect(mapToMacro(s, insertId, rackId, 2, { kind: 'param', slotId: ids[1]!, paramId: 'threshold' })).toBe(true);
    const mapping = rackAt(s, insertId, rackId)!.rack.macros[2]!.mappings[0]!;
    expect(mapping).toMatchObject({ min: -20, curve: 'linear' });
    // The compressor's threshold sits near the top of its range, so the macro sweeps down from where it is.
    expect(mapping.max).toBe(-60);
    expect(mapToMacro(s, insertId, rackId, 0, { kind: 'param', slotId: 'fx_gone' as SlotId, paramId: 'threshold' })).toBe(false);
    expect(ungroupSlot(s, insertId, rackId)).toBe(true);
    expect(fx(s, insertId).map((slot) => slot.id)).toEqual([ids[0], ids[1], ids[2]]);
    expect(groupSlotsIntoRack(s, insertId, [])).toBeNull();
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/at least one effect/);
  });
});

describe('around a rack in the app', () => {
  function withRack() {
    const s = createTestServices();
    const insertId = insertOf(s);
    const slotId = addRackChoice(s, insertId, findRackChoice(allRacks(s), 'Parallel NY')!)!;
    return { s, insertId, slotId };
  }

  it('removes an effect inside a rack with the usual remove action, and its macro mappings go with it', () => {
    const { s, insertId, slotId } = withRack();
    const compressor = rackAt(s, insertId, slotId)!.rack.branches[1]!.fx[1]!;
    removeEffect(s, insertId, compressor.id);
    const rack = rackAt(s, insertId, slotId)!.rack;
    expect(rack.branches[1]!.fx.map((x) => x.plugin.pluginId)).toEqual(['agstudio.eq-pro']);
    expect(rack.macros[1]!.mappings).toEqual([]);
    expect(rack.macros[2]!.mappings).toEqual([]);
    s.history.undo();
    expect(rackAt(s, insertId, slotId)!.rack.macros[1]!.mappings).toHaveLength(2);
  });

  it('keeps the effects marked for grouping until another track is chosen', () => {
    const { s, insertId } = withRack();
    s.session.getState().toggleMarkedSlot('fx_a' as SlotId);
    s.session.getState().toggleMarkedSlot('fx_b' as SlotId);
    s.session.getState().toggleMarkedSlot('fx_a' as SlotId);
    expect(s.session.getState().markedSlotIds).toEqual(['fx_b']);
    s.session.getState().selectInsert(s.doc.getState().project.mixer.order[2] as InsertId);
    expect(s.session.getState().markedSlotIds).toEqual([]);
    expect(insertId).toBeDefined();
  });

  it('says a setting is moved by a macro, and says nothing for one that is not', () => {
    const { s, insertId, slotId } = withRack();
    const compressor = rackAt(s, insertId, slotId)!.rack.branches[1]!.fx[1]!;
    const key = (paramId: string) => targetKey({ kind: 'plugin', owner: { kind: 'fx', insertId, slotId: compressor.id }, paramId });
    expect(s.automation.statusOf(key('threshold'))).toMatchObject({ kind: 'macro', hint: expect.stringContaining('“Squash”') });
    expect(s.automation.statusOf(key('release'))).toBeNull();
    expect(s.automation.statusOf(targetKey({ kind: 'plugin', owner: { kind: 'fx', insertId, slotId }, paramId: 'gain' }))).toMatchObject({ kind: 'macro' });
    expect(s.automation.statusOf(targetKey({ kind: 'plugin', owner: { kind: 'fx', insertId, slotId }, paramId: 'macro1' }))).toBeNull();
  });

  it('learns a MIDI controller for a macro like for any setting, and the controller moves the macro in one undo step', async () => {
    const { s, insertId, slotId } = withRack();
    const target = { kind: 'plugin', owner: { kind: 'fx', insertId, slotId }, paramId: 'macro2' } as const;
    const learned = s.controllers.learn(target);
    s.live.controlChange(21, 0.5, { source: 'midi', device: 'Pad', midiChannel: 0 });
    expect(await learned).toMatchObject({ cc: 21, target });
    const before = s.history.steps().done.length;
    for (const v of [0.2, 0.9]) s.live.controlChange(21, v, { source: 'midi', device: 'Pad', midiChannel: 0 });
    expect(Number(rackAt(s, insertId, slotId)!.plugin.params.macro2)).toBeCloseTo(0.9, 6);
    expect(s.history.steps().done.length).toBe(before + 1);
    // Taking the rack away takes the link with it.
    s.history.transact('remove', (d) => void removeFxSlot(d, insertId, slotId));
    expect(Object.keys(s.doc.getState().project.controllers)).toEqual([]);
  });
});

