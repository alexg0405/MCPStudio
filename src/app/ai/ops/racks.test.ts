import { describe, expect, it } from 'vitest';
import { RACK_PLUGIN_ID } from '@core/model/rack';
import type { Rack } from '@core/model/types';
import { pluginCatalog } from '../catalog';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';
import { createTestServices } from '../../testing';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const project = (s: S) => s.doc.getState().project;
const insertByName = (s: S, name: string) => Object.values(project(s).mixer.inserts).find((i) => i.name === name)!;
const rackOn = (s: S, name: string): Rack => insertByName(s, name).fx.find((f) => f.rack)!.rack!;

describe('add_rack', () => {
  it('puts a factory rack on a track with its macros mapped, as one undo step', () => {
    const s = createTestServices();
    const before = project(s);
    const res = run(s, [
      { op: 'add_insert', name: 'Drums' },
      { op: 'add_rack', ref: '@ny', insert: 'Drums', rack: 'parallel ny' },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes.at(-1)).toMatch(/^Put the rack “Parallel NY compression” on .*\(macros: 1 Blend, 2 Squash, 3 Snap, 4 Sparkle, 5 Output\)$/);
    const rack = rackOn(s, 'Drums');
    expect(rack.branches.map((b) => b.name)).toEqual(['Dry', 'Squashed']);
    expect(rack.macros[0]!.mappings).toHaveLength(1);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });

  it('adds an empty rack and says why it cannot be made', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_insert', name: 'Bus' },
      { op: 'add_rack', insert: 'Bus', split: 'bands', branches: 3 },
      { op: 'add_rack', insert: 'Bus', rack: 'No such rack' },
      { op: 'add_rack', insert: 'Bus', split: 'diagonal' },
      { op: 'add_rack', insert: 'Nowhere' },
    ]);
    expect(rackOn(s, 'Bus').branches.map((b) => b.name)).toEqual(['Low', 'Mid', 'High']);
    expect(rackOn(s, 'Bus').crossovers).toHaveLength(2);
    expect(res.warnings.some((w) => /no rack "No such rack"/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /splits as: parallel, bands, midside, leftright/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /no mixer track "Nowhere"/.test(w))).toBe(true);
  });

  it('adding the rack plugin with add_effect makes a real (empty) rack too', () => {
    const s = createTestServices();
    run(s, [{ op: 'add_insert', name: 'Bus' }, { op: 'add_effect', insert: 'Bus', plugin: RACK_PLUGIN_ID }]);
    expect(rackOn(s, 'Bus').branches).toHaveLength(1);
  });
});

describe('building a rack by hand', () => {
  it('fills branches, edits and removes the effects in them, and maps a macro to what it moves', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_insert', name: 'Lead' },
      { op: 'add_rack', ref: '@rack', insert: 'Lead', split: 'parallel', branches: 2 },
      { op: 'rack_branch', rack: '@rack', action: 'edit', branch: 1, name: 'Dry', level_db: -3 },
      { op: 'rack_branch', rack: '@rack', action: 'edit', branch: 2, name: 'Wet' },
      { op: 'rack_effect', ref: '@sat', rack: '@rack', branch: 'wet', plugin: 'agstudio.saturator', params: [{ name: 'drive', value: 12 }] },
      { op: 'rack_effect', ref: '@eq', rack: '@rack', branch: 'Wet', plugin: 'agstudio.eq-pro', position: 1 },
      { op: 'edit_effect', effect: '@sat', params: [{ name: 'drive', value: 18 }], mix: 80 },
      { op: 'rack_macro', rack: '@rack', macro: 1, name: 'Heat', value: 0.5, map: [
        { kind: 'param', effect: '@sat', param: 'drive', min: 0, max: 30 },
        { kind: 'effect_mix', effect: '@sat' },
        { kind: 'branch_level', branch: 'Wet', min: -30, max: 0, curve: 'exponential' },
        { kind: 'output', min: 0, max: -4 },
      ] },
    ]);
    expect(res.warnings).toEqual([]);
    const lead = insertByName(s, 'Lead');
    const rack = rackOn(s, 'Lead');
    expect(rack.branches.map((b) => [b.name, b.levelDb])).toEqual([['Dry', -3], ['Wet', 0]]);
    expect(rack.branches[1]!.fx.map((fx) => fx.plugin.pluginId)).toEqual(['agstudio.eq-pro', 'agstudio.saturator']);
    const saturator = rack.branches[1]!.fx[1]!;
    expect(saturator.plugin.params.drive).toBe(18);
    expect(saturator.mix).toBeCloseTo(0.8, 9);
    expect(rack.macros[0]!.name).toBe('Heat');
    expect(lead.fx[0]!.plugin.params.macro1).toBe(0.5);
    expect(rack.macros[0]!.mappings.map((m) => [m.target.kind, m.min, m.max, m.curve])).toEqual([
      ['param', 0, 30, 'linear'],
      ['mix', 0.8, 0, 'linear'],
      ['branch', -30, 0, 'exponential'],
      ['gain', 0, -4, 'linear'],
    ]);
    // Taking mappings off, moving an effect to the other branch and removing one.
    const more = run(s, [
      { op: 'rack_macro', rack: 'fx_missing', macro: 1 },
      { op: 'rack_macro', rack: lead.fx[0]!.id, macro: 'heat', unmap: [{ kind: 'output' }] },
      { op: 'rack_effect', rack: lead.fx[0]!.id, branch: 'Dry', effect: saturator.id },
      { op: 'remove_effect', effect: rack.branches[1]!.fx[0]!.id },
    ]);
    expect(more.warnings.some((w) => /no effect "fx_missing"/.test(w))).toBe(true);
    const after = rackOn(s, 'Lead');
    expect(after.macros[0]!.mappings.map((m) => m.target.kind)).toEqual(['param', 'mix', 'branch']);
    expect(after.branches[0]!.fx.map((fx) => fx.plugin.pluginId)).toEqual(['agstudio.saturator']);
    expect(after.branches[1]!.fx).toEqual([]);
  });

  it('refuses a rack inside a rack, a macro that does not exist and a mapping to something missing', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_insert', name: 'Lead' },
      { op: 'add_rack', ref: '@rack', insert: 'Lead' },
      { op: 'add_effect', ref: '@outside', insert: 'Lead', plugin: 'agstudio.eq-pro' },
      { op: 'rack_effect', rack: '@rack', branch: 1, plugin: RACK_PLUGIN_ID },
      { op: 'rack_macro', rack: '@rack', macro: 9, name: 'x' },
      { op: 'rack_macro', rack: '@rack', macro: 1, map: [{ kind: 'param', effect: '@outside', param: 'b1Freq' }] },
      { op: 'rack_macro', rack: '@rack', macro: 1, map: [{ kind: 'crossover', crossover: 1 }] },
      { op: 'rack_effect', rack: '@outside', branch: 1, plugin: 'agstudio.eq-pro' },
    ]);
    expect(res.warnings.some((w) => /cannot go inside another rack/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /no macro "9"/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /not inside this rack/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /@outside is not a rack|is not a rack/.test(w))).toBe(true);
    expect(rackOn(s, 'Lead').macros[0]!.mappings).toHaveLength(0);
  });

  it('changes the split, the crossovers, the branches and the rack itself', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_insert', name: 'Bus' },
      { op: 'add_rack', ref: '@rack', insert: 'Bus' },
      { op: 'edit_rack', rack: '@rack', split: 'bands', mix: 60, output_db: -3 },
      { op: 'edit_rack', rack: '@rack', crossovers_hz: [250] },
      { op: 'rack_branch', rack: '@rack', action: 'add', name: 'Air' },
      { op: 'edit_rack', rack: '@rack', crossovers_hz: [250, 5000] },
      { op: 'edit_rack', rack: '@rack', crossovers_hz: [250] },
      { op: 'rack_branch', rack: '@rack', action: 'edit', branch: 'Air', mute: true, pan: 0.5 },
      { op: 'rack_branch', rack: '@rack', action: 'remove', branch: 'Low' },
      { op: 'rack_branch', rack: '@rack', action: 'remove', branch: 1 },
    ]);
    const bus = insertByName(s, 'Bus');
    expect(bus.fx[0]!.mix).toBeCloseTo(0.6, 9);
    expect(bus.fx[0]!.plugin.params.gain).toBe(-3);
    const rack = rackOn(s, 'Bus');
    expect(rack.branches).toHaveLength(2);
    expect(rack.crossovers).toHaveLength(1);
    expect(res.warnings.filter((w) => /crossovers_hz needs 2 frequencies/.test(w))).toHaveLength(1);
    expect(res.warnings.some((w) => /needs at least 2 branches/.test(w))).toBe(true);
  });

  it('groups effects into a rack and takes it apart again', () => {
    const s = createTestServices();
    run(s, [
      { op: 'add_insert', name: 'Bus' },
      { op: 'add_effect', ref: '@a', insert: 'Bus', plugin: 'agstudio.eq-pro' },
      { op: 'add_effect', ref: '@b', insert: 'Bus', plugin: 'agstudio.compressor' },
      { op: 'add_effect', ref: '@c', insert: 'Bus', plugin: 'agstudio.saturator' },
    ]);
    const ids = insertByName(s, 'Bus').fx.map((f) => f.id);
    const res = run(s, [{ op: 'group_into_rack', ref: '@rack', insert: 'Bus', effects: [ids[1]!, ids[2]!] }]);
    expect(res.changes.at(-1)).toMatch(/Put 2 effects of .* into a rack/);
    expect(insertByName(s, 'Bus').fx.map((f) => f.id)).toEqual([ids[0], expect.any(String)]);
    expect(rackOn(s, 'Bus').branches[0]!.fx.map((fx) => fx.id)).toEqual([ids[1], ids[2]]);
    const rackId = insertByName(s, 'Bus').fx[1]!.id;
    run(s, [{ op: 'edit_rack', rack: rackId, ungroup: true }]);
    expect(insertByName(s, 'Bus').fx.map((f) => f.id)).toEqual(ids);
  });

  it('saves a rack as one of the musician’s own, which add_rack then finds by name', () => {
    const s = createTestServices();
    run(s, [
      { op: 'add_insert', name: 'Drums' },
      { op: 'add_rack', ref: '@rack', insert: 'Drums', rack: 'Mid/side widener' },
      { op: 'save_rack', rack: '@rack', name: 'My widener', description: 'For pads' },
    ]);
    expect(s.presets.racks().map((r) => r.file.name)).toEqual(['My widener']);
    run(s, [{ op: 'add_insert', name: 'Pads' }, { op: 'add_rack', insert: 'Pads', rack: 'my widener' }]);
    expect(rackOn(s, 'Pads').branches.map((b) => b.name)).toEqual(['Mid', 'Side']);
  });
});

describe('what the AI is told about racks', () => {
  it('get_mixer shows the inside of a rack, with the macros named and what each one drives', () => {
    const s = createTestServices();
    run(s, [{ op: 'add_insert', name: 'Drums' }, { op: 'add_rack', insert: 'Drums', rack: 'Dub delay throws' }]);
    const mixer = runReadTool(s, 'get_mixer', { insert: 'Drums' }) as { inserts: { fx: { plugin: string; params: { id: string }[]; rack?: { split: string; branches: { name: string; effects: { name: string }[] }[]; macros: { name: string; value: number; drives: { target: string; sweep: string }[] }[] } }[] }[] };
    const slot = mixer.inserts[0]!.fx[0]!;
    expect(slot.plugin).toBe(RACK_PLUGIN_ID);
    expect(slot.rack?.split).toBe('parallel');
    expect(slot.rack?.branches.map((b) => b.name)).toEqual(['Dry', 'Echo throws']);
    expect(slot.rack?.branches[1]!.effects.map((e) => e.name)).toEqual(['Delay', 'Reverb']);
    expect(slot.rack?.macros[0]).toMatchObject({ name: 'Throw', value: 0.85 });
    expect(slot.rack?.macros[0]!.drives[0]).toMatchObject({ target: 'Echo throws · Level' });
    expect(slot.rack?.macros[1]!.drives[0]!.target).toBe('Echo throws · Delay · Feedback');
    expect(slot.params.some((param) => /^macro/.test(param.id))).toBe(false);
  });

  it('get_racks lists the library and gives one in full', () => {
    const s = createTestServices();
    const all = runReadTool(s, 'get_racks', {}) as { racks: { name: string; source: string; inside: string }[] };
    expect(all.racks.map((r) => r.name)).toEqual(['Parallel NY compression', 'Multiband saturation', 'Mid/side widener', 'Dub delay throws with macro', 'Lo-fi tape with macro']);
    expect(all.racks[1]!.inside).toMatch(/^Frequency bands: Low, Mid, High\. Macros: Low drive/);
    const one = runReadTool(s, 'get_racks', { rack: 'lo-fi' }) as { name: string; rack: { macros: { name: string; drives: unknown[] }[] } };
    expect(one.name).toBe('Lo-fi tape with macro');
    expect(one.rack.macros[0]).toMatchObject({ name: 'Wear' });
    expect(one.rack.macros[0]!.drives).toHaveLength(4);
    expect(runReadTool(s, 'get_racks', { rack: 'zzz' })).toMatchObject({ error: expect.stringContaining('no rack "zzz"') });
  });

  it('the plugin catalog lists the rack effect and every rack, the musician’s own too', () => {
    const s = createTestServices();
    s.presets.saveRack({
      format: 'agstudio-rack',
      version: 1,
      name: 'Mine',
      description: 'My own.',
      slot: { id: 'fx_x' as never, plugin: { pluginId: RACK_PLUGIN_ID, pluginVersion: 1, params: {} }, enabled: true, mix: 1, sidechain: null, rack: { split: 'parallel', crossovers: [], branches: [], macros: [] } },
    });
    const text = pluginCatalog(s.plugins, s.presets).text;
    expect(text).toMatch(/- agstudio\.rack "Rack" \[Utility\]: A container for effects/);
    expect(text).toContain('Effect racks (add_rack action');
    expect(text).toContain('- "Parallel NY compression": New York compression');
    expect(text).toContain('inside: Parallel: Dry, Squashed. Macros: Blend, Squash, Snap, Sparkle, Output');
    expect(text).toContain('- "Mine" (the musician\'s own): My own.');
  });
});
