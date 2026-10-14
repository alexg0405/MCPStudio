import { describe, expect, it } from 'vitest';
import { defineEffect, p, type PluginDef } from '@agstudio/sdk';
import { MASTER } from '@core/model/types';
import { addInstrumentChannel } from './actions/channels';
import { addEffectToSelectedInsert } from './actions/mixer';
import { applyAnswer } from './ai/apply';
import { pluginCatalog } from './ai/catalog';
import {
  applyPreset,
  isAtPreset,
  memoryPresetStorage,
  PresetLibrary,
  presetChoices,
  presetFileBytes,
  presetValues,
  randomValues,
  readPresetFile,
  varyValues,
  type UserPreset,
} from './presets';
import { createTestServices } from './testing';

const tick = () => new Promise((r) => setTimeout(r, 0));

const fx = defineEffect({
  id: 'test.fx',
  name: 'Test FX',
  version: 2,
  params: {
    cutoff: p.float(20, 20000, 1000, { scale: 'log', unit: 'Hz' }),
    mode: p.enum(['a', 'b', 'c'] as const, 'a'),
    voices: p.int(1, 4, 2),
    on: p.bool(true),
    output: p.float(-24, 6, 0, { unit: 'dB' }),
  },
  presets: [{ name: 'Bright', params: { cutoff: 8000 } }],
  // Version 1 stored the cutoff in kHz.
  migrate: (old) => ({
    params: { ...old.params, cutoff: Number(old.params.cutoff ?? 1) * 1000 },
    state: undefined,
  }),
  create: () => {
    throw new Error('not in tests');
  },
}) as PluginDef;

describe('PresetLibrary', () => {
  it('saves, replaces by name, renames and removes, and stores every change', async () => {
    const storage = memoryPresetStorage();
    const lib = new PresetLibrary(storage);
    await lib.load();
    const a = lib.save({ pluginId: 'test.fx', version: 2, name: ' Warm ', params: { cutoff: 500 } });
    expect(a.name).toBe('Warm');
    const again = lib.save({ pluginId: 'test.fx', version: 2, name: 'warm', params: { cutoff: 700 } });
    expect(again.id).toBe(a.id);
    expect(lib.forPlugin('test.fx')).toHaveLength(1);
    expect(lib.get(a.id)?.params.cutoff).toBe(700);
    lib.save({ pluginId: 'test.fx', version: 2, name: 'Air', params: {} });
    expect(lib.forPlugin('test.fx').map((x) => x.name)).toEqual(['Air', 'warm']);
    expect(lib.rename(a.id, 'Air')).toBe(false);
    expect(lib.rename(a.id, 'Dark')).toBe(true);
    await tick();
    expect(storage.list.map((x) => x.name).sort()).toEqual(['Air', 'Dark']);
    const removed = lib.remove(a.id)!;
    expect(lib.forPlugin('test.fx').map((x) => x.name)).toEqual(['Air']);
    lib.restore(removed);
    expect(lib.forPlugin('test.fx')).toHaveLength(2);
  });

  it('loads what was stored, keeping presets saved before loading finished and skipping broken ones', async () => {
    const stored: UserPreset[] = [
      { id: 'pre_1', pluginId: 'test.fx', version: 2, name: 'Old', params: {}, saved: 1 },
      { id: 'pre_2', name: 'broken' } as UserPreset,
    ];
    const lib = new PresetLibrary(memoryPresetStorage(stored));
    lib.save({ pluginId: 'test.fx', version: 2, name: 'New', params: {} });
    await lib.load();
    expect(lib.forPlugin('test.fx').map((x) => x.name)).toEqual(['New', 'Old']);
  });

  it('says so when presets cannot be stored', async () => {
    const errors: string[] = [];
    const lib = new PresetLibrary(
      { read: () => Promise.resolve([]), write: () => Promise.reject(new Error('quota')) },
      (m) => errors.push(m),
    );
    lib.save({ pluginId: 'test.fx', version: 2, name: 'X', params: {} });
    await tick();
    expect(errors[0]).toMatch(/couldn’t be saved.*quota/);
  });
});

describe('preset values', () => {
  it('fills in defaults and upgrades presets saved by an older plugin version', () => {
    expect(presetValues(fx, { params: { cutoff: 8000 } }).params).toEqual({
      cutoff: 8000,
      mode: 'a',
      voices: 2,
      on: true,
      output: 0,
    });
    expect(presetValues(fx, { params: { cutoff: 2 }, version: 1 }).params.cutoff).toBe(2000);
  });

  it('tells when settings are exactly at a preset', () => {
    const bright = { name: 'Bright', source: 'factory' as const, params: { cutoff: 8000 } };
    expect(isAtPreset(fx, { params: { cutoff: 8000 } }, bright)).toBe(true);
    expect(isAtPreset(fx, { params: { cutoff: 8000, mode: 'b' } }, bright)).toBe(false);
  });

  it('randomizes within each range and leaves output levels alone', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = randomValues(fx, { output: -6 }, rand);
      expect(v.output).toBe(-6);
      expect(Number(v.cutoff)).toBeGreaterThanOrEqual(20);
      expect(Number(v.cutoff)).toBeLessThanOrEqual(20000);
      expect(Number.isInteger(v.voices)).toBe(true);
      seen.add(String(v.mode));
      seen.add(`v${String(v.voices)}`);
    }
    // Every option and every whole number turns up.
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'v1', 'v2', 'v3', 'v4']);
    const varied = varyValues(fx, { cutoff: 1000, mode: 'b', voices: 2, on: false, output: 0 }, 0.05, () => 1);
    expect(varied.mode).toBe('b');
    expect(varied.on).toBe(false);
    expect(Number(varied.cutoff)).toBeGreaterThan(1000);
    expect(Number(varied.cutoff)).toBeLessThan(1700);
  });
});

describe('preset files', () => {
  it('round-trips a plugin’s settings, and explains files it can’t read', () => {
    const plugins = { get: (id: string) => (id === 'test.fx' ? fx : undefined) };
    const bytes = presetFileBytes(fx, 'Night', { params: { cutoff: 300, mode: 'c' } });
    const read = readPresetFile(new TextDecoder().decode(bytes), plugins);
    expect('value' in read && read.value).toMatchObject({ pluginId: 'test.fx', name: 'Night', params: { cutoff: 300, mode: 'c' } });
    expect(readPresetFile('nope', plugins)).toEqual({ error: expect.stringMatching(/isn’t a preset file/) });
    expect(readPresetFile('{"format":"agstudio-preset","plugin":"x.y","pluginName":"Other"}', plugins)).toEqual({
      error: 'This preset is for “Other”, which isn’t installed.',
    });
  });
});

describe('using presets', () => {
  it('loads a preset in one undo step and remembers its name', () => {
    const s = createTestServices();
    const reverb = s.plugins.get('agstudio.reverb')!;
    const added = addEffectToSelectedInsert(s, reverb.id)!;
    const owner = { kind: 'fx' as const, ...added };
    const hall = presetChoices(reverb, s.presets).find((c) => c.name === 'Hall')!;
    const before = s.history.steps().done.length;
    applyPreset(s, owner, reverb, hall);
    expect(s.history.steps().done.length).toBe(before + 1);
    expect(s.doc.getState().project.mixer.inserts[MASTER]!.fx.at(-1)!.plugin.params.decay).toBe(3.2);
    expect(s.presets.loadedInto(owner)).toBe('Hall');
  });

  it('adds a channel named after an instrument preset, with its settings', () => {
    const s = createTestServices();
    const osc = s.plugins.get('agstudio.3xosc')!;
    const mine = s.presets.save({ pluginId: osc.id, version: osc.version, name: 'Glass keys', params: { cutoff: 2345 } });
    const id = addInstrumentChannel(s, osc.id, { ...mine, source: 'user' })!;
    const ch = s.doc.getState().project.channels[id]!;
    expect(ch.name).toBe('Glass keys');
    expect(ch.kind === 'instrument' && ch.plugin.params.cutoff).toBe(2345);
  });

  it('the AI sees your presets and can load them by name', () => {
    const s = createTestServices();
    const osc = s.plugins.get('agstudio.3xosc')!;
    s.presets.save({ pluginId: osc.id, version: osc.version, name: 'Glass keys', params: { cutoff: 2345 } });
    expect(pluginCatalog(s.plugins, s.presets).text).toContain("the musician's own presets: Glass keys");
    const res = applyAnswer(
      s,
      { message: 'ok', actions: [{ op: 'add_channel', plugin: 'agstudio.3xosc', name: 'Keys', preset: 'glass keys' }] },
      { previousBeat: null },
    );
    expect(res.warnings).toEqual([]);
    const ch = Object.values(s.doc.getState().project.channels).find((c) => c.name === 'Keys')!;
    expect(ch.kind === 'instrument' && ch.plugin.params.cutoff).toBe(2345);
  });
});
