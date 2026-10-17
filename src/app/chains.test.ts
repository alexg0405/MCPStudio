import { describe, expect, it } from 'vitest';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { addFxSlot, addInsert, MAX_FX_SLOTS } from '@core/ops/mixer';
import { defineEffect, p, type PluginDef } from '@agstudio/sdk';
import { applyChain, applyChainToDraft, saveInsertChain } from './actions/chains';
import {
  chainChoices,
  chainFileBytes,
  chainFromInsert,
  findChainChoice,
  readChain,
  readChainFile,
  type ChainPreset,
} from './chains';
import { BUS_NAMES } from './mix/layout';
import { FACTORY_CHAINS, VOCALS_BUS_FX } from './mix/vocal-chains';
import { memoryPresetStorage, PresetLibrary } from './presets';
import { createTestServices } from './testing';

const tick = () => new Promise((r) => setTimeout(r, 0));
type S = ReturnType<typeof createTestServices>;
const project = (s: S) => s.doc.getState().project;
const insert = (s: S, id: InsertId) => project(s).mixer.inserts[id]!;
const ids = (s: S, id: InsertId) => insert(s, id).fx.map((f) => f.plugin.pluginId.replace('agstudio.', ''));

/** A song with a vocal insert (empty) and, optionally, the Reverb and Delay returns the mix setup would make. */
function vocalSong(returns: boolean): { s: S; vocal: InsertId; reverb?: InsertId; delay?: InsertId } {
  const s = createTestServices();
  const vocal = 'ins_vocal' as InsertId;
  const reverb = 'ins_reverb' as InsertId;
  const delay = 'ins_delay' as InsertId;
  s.history.transact('tracks', (d) => {
    addInsert(d, makeInsert(vocal, 'Lead vocal'));
    if (returns) {
      addInsert(d, makeInsert(reverb, BUS_NAMES.reverb));
      addInsert(d, makeInsert(delay, BUS_NAMES.delay));
    }
  });
  return returns ? { s, vocal, reverb, delay } : { s, vocal };
}

const POP = FACTORY_CHAINS.find((c) => c.name === 'Clean pop vocal')!;

describe('factory vocal chains', () => {
  it('has the six chains, and uses only plugins, presets and params that exist', () => {
    const s = createTestServices();
    expect(FACTORY_CHAINS.map((c) => c.name)).toEqual([
      'Clean pop vocal',
      'Rap vocal',
      'Airy ballad',
      'Lo-fi vocal',
      'Trap auto-tune vocal',
      'Podcast voice',
    ]);
    for (const chain of FACTORY_CHAINS) {
      expect(readChain(chain), chain.name).not.toHaveProperty('error');
      expect(chain.description, chain.name).toBeTruthy();
      for (const step of chain.steps) {
        const def = s.plugins.get(step.pluginId);
        expect(def, `${chain.name}: ${step.pluginId}`).toBeDefined();
        expect(def!.kind).toBe('effect');
        if (step.preset) expect(def!.presets?.map((x) => x.name), `${chain.name}: ${step.label}`).toContain(step.preset);
        for (const k of Object.keys(step.params ?? {})) expect(def!.params[k], `${chain.name}: ${step.pluginId}.${k}`).toBeDefined();
        expect(step.label.length).toBeGreaterThan(3);
      }
      // As inserts (no returns in the mix) every chain fits the ten slots.
      expect(chain.steps.length, chain.name).toBeLessThanOrEqual(MAX_FX_SLOTS);
    }
    const used = (name: string) => FACTORY_CHAINS.find((c) => c.name === name)!.steps.map((x) => x.pluginId.replace('agstudio.', ''));
    expect(used('Trap auto-tune vocal')).toContain('tune');
    expect(FACTORY_CHAINS.flatMap((c) => c.steps.map((x) => x.pluginId.replace('agstudio.', '')))).toEqual(
      expect.arrayContaining(['eq-pro', 'tune', 'de-esser', 'compressor', 'saturator', 'doubler', 'reverb', 'delay']),
    );
  });

  it('every send step is also an insert effect that sounds right on its own (a reverb or delay with its own mix)', () => {
    for (const chain of FACTORY_CHAINS)
      for (const step of chain.steps.filter((x) => x.send)) {
        expect(step.params?.mix, `${chain.name}: ${step.label}`).toBeLessThanOrEqual(0.25);
        expect(step.send!.db).toBeLessThanOrEqual(-8);
      }
  });

  it('the Vocals bus carries the pop chain’s EQ, compressor and de-esser', () => {
    expect(VOCALS_BUS_FX.map((x) => x.pluginId)).toEqual(['agstudio.eq-pro', 'agstudio.compressor', 'agstudio.de-esser']);
    for (const step of VOCALS_BUS_FX) expect(POP.steps).toContain(step);
  });
});

describe('applying a chain', () => {
  it('a factory chain’s Tune follows the song’s key; without one it keeps the preset', () => {
    const TRAP = FACTORY_CHAINS.find((c) => c.name === 'Trap auto-tune vocal')!;
    const tuneOf = (s: S, id: InsertId) => insert(s, id).fx.find((f) => f.plugin.pluginId === 'agstudio.tune')!.plugin.params;
    const keyed = vocalSong(false);
    keyed.s.history.transact('key', (d) => {
      d.transport.key = { root: 5, scale: 'minor' };
    });
    const res = applyChain(keyed.s, keyed.vocal, TRAP, 'replace')!;
    expect(tuneOf(keyed.s, keyed.vocal)).toMatchObject({ key: 'F', scale: 'minor' });
    // Retuned, so the slot isn't named after the A-minor preset.
    expect(res.slots.some((x) => x.preset?.includes('A minor'))).toBe(false);
    const plain = vocalSong(false);
    applyChain(plain.s, plain.vocal, TRAP, 'replace');
    expect(tuneOf(plain.s, plain.vocal)).toMatchObject({ key: 'A', scale: 'minor' });
  });

  it('puts the whole chain on an empty insert as one undo step, and undo takes it off', () => {
    const { s, vocal } = vocalSong(false);
    const before = project(s);
    const cursor = s.history.status().cursor;
    const res = applyChain(s, vocal, POP, 'replace')!;
    // No returns in this mix: the reverb and the delay are insert effects.
    expect(ids(s, vocal)).toEqual(['eq-pro', 'compressor', 'de-esser', 'saturator', 'doubler', 'reverb', 'delay']);
    expect(res.sends).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(s.history.status().undoLabel).toBe('Chain: Clean pop vocal');
    expect(s.history.status().cursor).toBe(cursor + 1);
    // Settings are the presets' (Compressor "Smooth vocals" with the chain's makeup), and the insert reverb is light.
    const fx = insert(s, vocal).fx;
    expect(fx[1]!.plugin.params).toMatchObject({ threshold: -20, ratio: 3, makeup: 2 });
    expect(fx[2]!.plugin.params).toMatchObject({ frequency: 6500, ratio: 3, range: 6 });
    expect(fx[5]!.plugin.params).toMatchObject({ mix: 0.12, decay: 1.8 });
    s.history.undo();
    expect(project(s)).toEqual(before);
    s.history.redo();
    expect(ids(s, vocal)).toHaveLength(7);
  });

  it('sends to the Reverb and Delay returns when the mix has them, instead of adding those effects', () => {
    const { s, vocal, reverb, delay } = vocalSong(true);
    const res = applyChain(s, vocal, POP, 'replace')!;
    expect(ids(s, vocal)).toEqual(['eq-pro', 'compressor', 'de-esser', 'saturator', 'doubler']);
    const routes = insert(s, vocal).routes;
    expect(routes.map((r) => r.to).sort()).toEqual([MASTER, reverb!, delay!].sort());
    const db = (to: InsertId) => Math.round(20 * Math.log10(routes.find((r) => r.to === to)!.level));
    expect(db(reverb!)).toBe(-14);
    expect(db(delay!)).toBe(-20);
    expect(res.sends).toEqual(['Reverb send -14 dB', 'Delay send -20 dB']);
    // Applying it again changes the same sends, not a second copy.
    applyChain(s, vocal, POP, 'replace');
    expect(insert(s, vocal).routes).toHaveLength(3);
    expect(ids(s, vocal)).toHaveLength(5);
  });

  it('replace takes out what was there; append adds after it', () => {
    const { s, vocal } = vocalSong(false);
    s.history.transact('own', (d) => {
      addFxSlot(d, vocal, makePluginInstance('agstudio.stereo', 1, {}));
      addFxSlot(d, vocal, makePluginInstance('agstudio.limiter', 1, {}));
    });
    const podcast = FACTORY_CHAINS.find((c) => c.name === 'Podcast voice')!;
    const appended = applyChain(s, vocal, podcast, 'append')!;
    expect(ids(s, vocal)).toEqual(['stereo', 'limiter', 'gate', 'eq-pro', 'compressor', 'de-esser', 'limiter']);
    expect(appended.removed).toBe(0);
    const replaced = applyChain(s, vocal, podcast, 'replace')!;
    expect(replaced.removed).toBe(7);
    expect(ids(s, vocal)).toEqual(['gate', 'eq-pro', 'compressor', 'de-esser', 'limiter']);
  });

  it('skips what does not fit in the ten slots and says so, without stopping', () => {
    const { s, vocal } = vocalSong(false);
    s.history.transact('fill', (d) => {
      for (let i = 0; i < 6; i++) addFxSlot(d, vocal, makePluginInstance('agstudio.stereo', 1, {}));
    });
    const res = applyChain(s, vocal, POP, 'append')!;
    expect(insert(s, vocal).fx).toHaveLength(MAX_FX_SLOTS);
    expect(res.slots).toHaveLength(4);
    expect(res.skipped).toHaveLength(3);
    expect(res.skipped[0]).toMatch(/no free effect slot/);
  });

  it('leaves out a plugin that is not installed, and a send on the return itself', () => {
    const { s, reverb } = vocalSong(true);
    const odd: ChainPreset = {
      name: 'Odd',
      steps: [
        { pluginId: 'missing.plugin', label: 'Mystery', preset: 'x' },
        { pluginId: 'agstudio.reverb', label: 'reverb', send: { to: 'reverb', db: -10 } },
        { pluginId: 'agstudio.stereo', label: 'stereo' },
      ],
    };
    const res = applyChain(s, reverb!, odd, 'replace')!;
    expect(res.skipped).toEqual(['Mystery: plugin not installed', 'reverb: this track is the reverb return']);
    expect(ids(s, reverb!)).toEqual(['stereo']);
  });

  it('works on the master and on a chain applied twice in one edit', () => {
    const { s } = vocalSong(false);
    s.history.transact('twice', (d) => {
      applyChainToDraft(d, s, MASTER, POP, 'replace');
      applyChainToDraft(d, s, MASTER, POP, 'replace');
    });
    expect(ids(s, MASTER)).toHaveLength(7);
  });

  it('names the plugins’ presets in their preset bars when the step is the preset itself', () => {
    const { s, vocal } = vocalSong(false);
    applyChain(s, vocal, POP, 'replace');
    const deEsser = insert(s, vocal).fx[2]!;
    expect(s.presets.loadedInto({ kind: 'fx', insertId: vocal, slotId: deEsser.id })).toBe('Gentle');
    // The EQ has params on top of its preset, so it isn't named.
    expect(s.presets.loadedInto({ kind: 'fx', insertId: vocal, slotId: insert(s, vocal).fx[0]!.id })).toBeUndefined();
  });
});

describe('your chains', () => {
  it('saves an insert’s effects with every setting, dry/wet and bypass, and applies them again exactly', () => {
    const { s, vocal } = vocalSong(false);
    applyChain(s, vocal, POP, 'replace');
    s.history.transact('tweak', (d) => {
      const fx = d.mixer.inserts[vocal]!.fx;
      fx[1]!.plugin.params.makeup = 3.5;
      fx[3]!.mix = 0.4;
      fx[4]!.enabled = false;
    });
    const saved = saveInsertChain(s, vocal, '  My vocal  ')!;
    expect(saved.name).toBe('My vocal');
    expect(saved.steps).toHaveLength(7);
    expect(saved.steps[1]).toMatchObject({ pluginId: 'agstudio.compressor', version: 1, params: { makeup: 3.5, ratio: 3 } });
    expect(saved.steps[3]).toMatchObject({ mix: 0.4 });
    expect(saved.steps[4]).toMatchObject({ enabled: false });
    // Onto another insert.
    const other = 'ins_other' as InsertId;
    s.history.transact('other', (d) => addInsert(d, makeInsert(other, 'Backing')));
    applyChain(s, other, s.presets.chains()[0]!, 'replace');
    const a = insert(s, vocal).fx;
    const b = insert(s, other).fx;
    expect(b.map((f) => [f.plugin.pluginId, f.plugin.params, f.mix, f.enabled])).toEqual(a.map((f) => [f.plugin.pluginId, f.plugin.params, f.mix, f.enabled]));
    // Saving with the same name replaces it; an insert without effects saves nothing.
    expect(saveInsertChain(s, vocal, 'my vocal')!.id).toBe(saved.id);
    expect(s.presets.chains()).toHaveLength(1);
    s.history.transact('empty', (d) => addInsert(d, makeInsert('ins_empty' as InsertId, 'Empty')));
    expect(saveInsertChain(s, 'ins_empty' as InsertId, 'Nothing')).toBeNull();
  });

  it('upgrades a saved plugin’s settings with its migrate when the plugin has moved on', () => {
    const s = createTestServices();
    const fx = defineEffect({
      id: 'test.migrating',
      name: 'Migrating',
      version: 2,
      params: { cutoff: p.float(20, 20000, 1000) },
      migrate: (old) => ({ params: { ...old.params, cutoff: Number(old.params.cutoff ?? 1) * 1000 }, state: undefined }),
      create: () => {
        throw new Error('not in tests');
      },
    }) as PluginDef;
    s.plugins.sync('user', [{ path: '/plugins/migrating/index.ts', def: fx }]);
    const vocal = 'ins_vocal' as InsertId;
    s.history.transact('track', (d) => addInsert(d, makeInsert(vocal, 'V')));
    const chain: ChainPreset = { name: 'Old', steps: [{ pluginId: 'test.migrating', label: 'Migrating', version: 1, params: { cutoff: 3 } }] };
    applyChain(s, vocal, chain, 'replace');
    expect(insert(s, vocal).fx[0]!.plugin).toMatchObject({ pluginVersion: 2, params: { cutoff: 3000 } });
  });

  it('keeps them in the library: replaces by name, renames, removes, restores and stores every change', async () => {
    const storage = memoryPresetStorage();
    const lib = new PresetLibrary(storage);
    await lib.load();
    const a = lib.saveChain(POP);
    const again = lib.saveChain({ ...POP, name: 'clean POP vocal', steps: POP.steps.slice(0, 2) });
    expect(again.id).toBe(a.id);
    expect(lib.chains()).toHaveLength(1);
    expect(lib.getChain(a.id)!.steps).toHaveLength(2);
    const b = lib.saveChain({ name: 'Other', steps: POP.steps.slice(0, 1) });
    expect(lib.renameChain(b.id, 'clean pop VOCAL')).toBe(false);
    expect(lib.renameChain(b.id, 'Dry')).toBe(true);
    await tick();
    expect(storage.chains.map((c) => c.name).sort()).toEqual(['Dry', 'clean POP vocal'.trim()]);
    const removed = lib.removeChain(b.id)!;
    expect(lib.chains().map((c) => c.name)).toEqual(['clean POP vocal']);
    lib.restoreChain(removed);
    expect(lib.chains()).toHaveLength(2);
    const versions = lib.getVersion();
    lib.saveChain({ name: 'Third', steps: POP.steps.slice(0, 1) });
    expect(lib.getVersion()).toBeGreaterThan(versions);
  });

  it('loads what was stored, keeps chains saved before loading finished and skips damaged ones', async () => {
    const stored = [
      { id: 'chn_1', name: 'Old', saved: 1, steps: [{ pluginId: 'agstudio.eq-pro', label: 'EQ' }] },
      { id: 'chn_2', name: 'broken', steps: 'no' },
      { name: 'no id', steps: [{ pluginId: 'agstudio.eq-pro', label: 'EQ' }] },
    ];
    const lib = new PresetLibrary(memoryPresetStorage([], stored as never));
    lib.saveChain({ name: 'New', steps: [{ pluginId: 'agstudio.stereo', label: 'Stereo' }] });
    await lib.load();
    expect(lib.chains().map((c) => c.name)).toEqual(['Old', 'New']);
  });

  it('says so when chains cannot be stored, and keeps them for the session on a storage without chains', async () => {
    const errors: string[] = [];
    const lib = new PresetLibrary(
      { read: () => Promise.resolve([]), write: () => Promise.resolve(), readChains: () => Promise.resolve([]), writeChains: () => Promise.reject(new Error('quota')) },
      (m) => errors.push(m),
    );
    lib.saveChain(POP);
    await tick();
    expect(errors[0]).toMatch(/chains couldn’t be saved.*quota/);
    const plain = new PresetLibrary({ read: () => Promise.resolve([]), write: () => Promise.resolve() }, (m) => errors.push(m));
    plain.saveChain(POP);
    await tick();
    expect(errors).toHaveLength(1);
    expect(plain.chains()).toHaveLength(1);
  });

  it('lists factory chains first and finds a chain by its name or a part of it', () => {
    const lib = new PresetLibrary(memoryPresetStorage());
    lib.saveChain({ name: 'Zed', steps: POP.steps.slice(0, 1) });
    lib.saveChain({ name: 'Clean pop vocal', steps: POP.steps.slice(0, 1) });
    const choices = chainChoices(lib.chains());
    expect(choices.map((c) => c.source)).toEqual([...FACTORY_CHAINS.map(() => 'factory'), 'user', 'user']);
    expect(findChainChoice(choices, 'rap vocal')!.name).toBe('Rap vocal');
    expect(findChainChoice(choices, 'podcast')!.name).toBe('Podcast voice');
    expect(findChainChoice(choices, 'vocal')).toBeUndefined();
    // One of yours with a factory chain's name wins.
    expect(findChainChoice(choices, 'clean pop vocal')!.source).toBe('user');
    expect(findChainChoice(choices, '')).toBeUndefined();
  });
});

describe('chain files (.agchain)', () => {
  const plugins = createTestServices().plugins;

  it('round-trips a chain', () => {
    for (const chain of FACTORY_CHAINS) {
      const read = readChainFile(new TextDecoder().decode(chainFileBytes(chain)), plugins);
      expect(read, chain.name).toEqual(chain);
    }
  });

  it('explains files it cannot use, in plain words', () => {
    const file = (o: object) => JSON.stringify({ format: 'agstudio-chain', formatVersion: 1, name: 'X', steps: [{ pluginId: 'agstudio.stereo', label: 'Stereo' }], ...o });
    const error = (text: string) => {
      const r = readChainFile(text, plugins);
      return 'error' in r ? r.error : null;
    };
    expect(error(file({}))).toBeNull();
    expect(error('nope')).toMatch(/isn’t a chain file/);
    expect(error(JSON.stringify({ format: 'agstudio-preset' }))).toMatch(/isn’t an AGstudio chain file/);
    expect(error(file({ name: '  ' }))).toMatch(/no name/);
    expect(error(file({ steps: [] }))).toMatch(/no effects/);
    expect(error(file({ steps: Array.from({ length: 21 }, () => ({ pluginId: 'agstudio.stereo' })) }))).toMatch(/at most 20/);
    expect(error(file({ steps: [{ pluginId: 'gone.plugin', label: 'Gone' }] }))).toMatch(/“Gone”.*isn’t installed/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.sampler', label: 'Sampler' }] }))).toMatch(/isn’t an effect/);
    expect(error(file({ steps: [{ label: 'x' }] }))).toMatch(/Effect 1 has no plugin/);
    expect(error(file({ steps: ['x'] }))).toMatch(/Effect 1 isn’t an effect/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.stereo', params: { width: 'a' }, mix: 2 }] }))).toMatch(/mix must be between 0 and 1/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.stereo', params: { width: {} } }] }))).toMatch(/“width”/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.stereo', send: { to: 'chorus', db: 0 } }] }))).toMatch(/reverb or the delay/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.stereo', send: { to: 'reverb', db: 40 } }] }))).toMatch(/between −60 and \+12/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.stereo', enabled: 'no' }] }))).toMatch(/true or false/);
    expect(error(file({ steps: [{ pluginId: 'agstudio.stereo', version: 0 }] }))).toMatch(/version/);
  });

  it('chainFromInsert skips an effect whose plugin is not installed and returns null for nothing', () => {
    const { s, vocal } = vocalSong(false);
    s.history.transact('gone', (d) => {
      addFxSlot(d, vocal, makePluginInstance('gone.plugin', 1, {}));
      addFxSlot(d, vocal, makePluginInstance('agstudio.stereo', 1, {}));
    });
    expect(chainFromInsert(project(s), vocal, s.plugins, 'X')!.steps.map((x) => x.pluginId)).toEqual(['agstudio.stereo']);
    expect(chainFromInsert(project(s) as Project, 'ins_nope' as InsertId, s.plugins, 'X')).toBeNull();
  });
});
