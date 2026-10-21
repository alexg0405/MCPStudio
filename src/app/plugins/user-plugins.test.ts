/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '@core/model/ids';
import { makePluginInstance } from '@core/model/defaults';
import { MASTER, type Project } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { readBundle, writeBundle } from '@core/plugin-bundle/bundle';
import { effectSource, folderServer, readFolder, syncRegistry, tempPlugins, writeFolder, type TempPlugins } from '../../../test/helpers/plugin-folder';
import { createTestServices } from '../testing';
import { exportBundle, shareLooseFiles } from './bundle-export';
import { inspectBundle, installBundle } from './bundle-install';
import { duplicatePlugin, renamePlugin } from './plugin-edit';
import { PluginRegistry } from './registry';
import { registerBuiltinPlugins } from './discover';
import { pluginServer } from './server';
import { PluginActionError } from './types';

interface World {
  disk: TempPlugins;
  services: ReturnType<typeof createTestServices>;
}

/** App services whose plugin server works on a temporary plugins folder, with hot reload standing in. */
async function world(): Promise<World> {
  const disk = await tempPlugins();
  const registry = new PluginRegistry();
  registerBuiltinPlugins(registry);
  const services = createTestServices({ plugins: registry, pluginServer: folderServer(disk.paths, registry) });
  return { disk, services };
}

const project = (w: World): Project => w.services.doc.getState().project;

describe('My plugins: the list', () => {
  let w: World;
  beforeEach(async () => void (w = await world()));
  afterEach(() => w.disk.cleanup());

  it('lists yours with their folders and the built-ins read-only, and says where the project uses them', async () => {
    await writeFolder(w.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop'));
    await syncRegistry(w.services.plugins, w.disk.paths.plugins);
    const up = w.services.userPlugins;
    await up.refresh();
    w.services.history.transact('Add fx', (d) => void addFxSlot(d, MASTER, makePluginInstance('user.tape-stop', 1, {})));
    const rows = up.rows();
    const mine = rows.find((row) => row.id === 'user.tape-stop')!;
    expect(mine).toMatchObject({ name: 'Tape stop', source: 'user', state: 'loaded', folder: 'tape-stop', version: 1, fileCount: 1 });
    expect(mine.usedIn.inserts).toHaveLength(1);
    expect(rows.some((row) => row.source === 'builtin')).toBe(true);
    expect(rows.findIndex((row) => row.source === 'builtin')).toBeGreaterThan(rows.findIndex((row) => row.id === 'user.tape-stop'));
    expect(() => up.userRow(rows.find((row) => row.source === 'builtin')!.id)).toThrow(/built in/);
  });

  it('shows a plugin that did not load, with the loader’s words', async () => {
    await writeFolder(w.disk.paths.plugins, 'broken', { 'index.ts': 'export default 1;' });
    w.services.plugins.sync('user', [{ path: '/plugins/broken/index.ts', def: 42 }]);
    await w.services.userPlugins.refresh();
    const broken = w.services.userPlugins.rows().find((row) => row.folder === 'broken')!;
    expect(broken).toMatchObject({ state: 'error', kind: null });
    expect(broken.error).toMatch(/default export/);
  });

  it('switches a plugin off and on again, and deletes to a trash that can bring it back', async () => {
    await writeFolder(w.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop'));
    await syncRegistry(w.services.plugins, w.disk.paths.plugins);
    const up = w.services.userPlugins;
    await up.refresh();
    await up.disable('user.tape-stop');
    expect(await readdir(w.disk.paths.disabled)).toEqual(['tape-stop']);
    expect(w.services.plugins.get('user.tape-stop')).toBeUndefined();
    expect(up.rows().find((row) => row.id === 'user.tape-stop')).toMatchObject({ state: 'disabled', folder: 'tape-stop' });
    await up.enable('user.tape-stop');
    expect(w.services.plugins.get('user.tape-stop')).toBeDefined();

    const entry = await up.trash('user.tape-stop');
    expect(entry).toMatch(/^tape-stop-\d{8}T\d{6}Z$/);
    expect(await readdir(w.disk.paths.plugins)).not.toContain('tape-stop');
    expect(up.trashRows()).toMatchObject([{ entry, folder: 'tape-stop', id: 'user.tape-stop', fileCount: 1 }]);
    await up.restore(entry);
    expect(await readFolder(w.disk.paths.plugins, 'tape-stop')).toEqual(effectSource('user.tape-stop', 'Tape stop'));
    expect(up.trashRows()).toEqual([]);
  });

  it('refuses to restore over a plugin that took the folder, and keeps the trash entry', async () => {
    await writeFolder(w.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop'));
    await syncRegistry(w.services.plugins, w.disk.paths.plugins);
    const up = w.services.userPlugins;
    await up.refresh();
    const entry = await up.trash('user.tape-stop');
    await writeFolder(w.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Another'));
    await expect(up.restore(entry)).rejects.toThrow(/already is a plugin/);
    expect(up.trashRows()).toHaveLength(1);
  });

  it('can delete a switched-off plugin too', async () => {
    await writeFolder(w.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop'));
    await syncRegistry(w.services.plugins, w.disk.paths.plugins);
    const up = w.services.userPlugins;
    await up.refresh();
    await up.disable('user.tape-stop');
    await up.trash('user.tape-stop');
    expect(up.trashRows()).toHaveLength(1);
    expect(await readdir(w.disk.paths.disabled)).toEqual([]);
  });

  it('says plainly that managing needs the dev server when there is none', async () => {
    const noServer = pluginServer((() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch);
    const services = createTestServices({ pluginServer: noServer });
    await services.userPlugins.refresh();
    expect(services.userPlugins.hasServer).toBe(false);
    await expect(services.userPlugins.disable('user.x')).rejects.toThrow(/There is no plugin/);
    await expect(services.userPlugins.requireServer('Installing a plugin')).rejects.toThrow(/needs AGstudio's dev server: run `agstudio`/);
  });
});

describe('sharing: export and import a bundle', () => {
  let a: World;
  let b: World;
  beforeEach(async () => {
    a = await world();
    b = await world();
    await writeFolder(a.disk.paths.plugins, 'tape-stop', {
      ...effectSource('user.tape-stop', 'Tape stop', 3),
      'README.md': '# Tape stop\nSlows to a halt.\n',
    });
    await syncRegistry(a.services.plugins, a.disk.paths.plugins);
    await a.services.userPlugins.refresh();
    a.services.presets.save({ pluginId: 'user.tape-stop', version: 3, name: 'Slow', params: { time: 2 } });
  });
  afterEach(async () => {
    await a.disk.cleanup();
    await b.disk.cleanup();
  });

  const exportFromA = async () => (await exportBundle(a.services.userPlugins, 'user.tape-stop', { author: 'Alex' })).bytes;

  it('gives identical files and presets after export → import', async () => {
    const exported = await exportBundle(a.services.userPlugins, 'user.tape-stop', { author: 'Alex', description: 'Stops the tape.' });
    expect(exported).toMatchObject({ fileName: 'Tape stop.agplugin', presetCount: 1 });
    const checked = await inspectBundle(b.services.userPlugins, exported.bytes);
    if (!checked.ok) throw new Error(checked.problems.join('; '));
    const { inspection } = checked;
    expect(inspection.collision).toEqual({ kind: 'none' });
    expect(inspection.newPresets).toBe(1);
    expect(inspection.cannotInstall).toBeNull();
    expect(inspection.capabilities.can[0]).toMatch(/effect/);

    const result = await installBundle(b.services.userPlugins, inspection.bundle, 'new');
    expect(result).toMatchObject({ id: 'user.tape-stop', folder: 'tape-stop', replaced: false, loaded: true, presetsAdded: 1 });
    expect(await readFolder(b.disk.paths.plugins, 'tape-stop')).toEqual(await readFolder(a.disk.paths.plugins, 'tape-stop'));
    expect(b.services.presets.forPlugin('user.tape-stop').map((p) => [p.name, p.params, p.version])).toEqual([['Slow', { time: 2 }, 3]]);
    expect(b.services.userPlugins.row('user.tape-stop')).toMatchObject({ author: 'Alex', description: '' });
  });

  it('refuses a plugin that would not pass the safety checks, and says what is wrong', async () => {
    await writeFolder(a.disk.paths.plugins, 'sneaky', { 'index.ts': `import { defineEffect } from '@agstudio/sdk';\nfetch('https://x.example');\nexport default defineEffect({ id: 'user.sneaky', name: 'Sneaky' });\n` });
    await syncRegistry(a.services.plugins, a.disk.paths.plugins);
    await a.services.userPlugins.refresh();
    const refused = exportBundle(a.services.userPlugins, 'user.sneaky');
    await expect(refused).rejects.toBeInstanceOf(PluginActionError);
    await expect(refused).rejects.toMatchObject({ problems: [expect.stringMatching(/network access/)] });
  });

  it('checks again on the server: a hand-made bundle object with forbidden code is not installed, and no draft is left', async () => {
    const bytes = await writeBundle({ id: 'user.sneaky', name: 'Sneaky', version: 1, kind: 'effect', files: [{ path: 'index.ts', content: `const x = 'user.sneaky'; fetch('/steal');` }] });
    const read = await readBundle(bytes);
    expect(read.ok).toBe(false);
    // Skip the browser-side reading: a malicious page could, so the server must refuse by itself.
    const files = [{ path: 'index.ts', content: `const x = 'user.sneaky'; fetch('/steal');` }];
    const bundle = { manifest: { id: 'user.sneaky', name: 'Sneaky', version: 1, kind: 'effect' as const, author: '', description: '', sdk: '^1.0.0', format: 'agstudio-plugin' as const, formatVersion: 1, files: [] }, files, presets: [] };
    await expect(installBundle(b.services.userPlugins, bundle, 'new')).rejects.toMatchObject({ problems: [expect.stringMatching(/network access/)] });
    expect((await readdir(b.disk.paths.plugins)).filter((name) => !name.startsWith('_'))).toEqual([]);
    expect(await readdir(b.disk.paths.drafts)).toEqual([]);
  });

  it('does not overwrite a different plugin with the same id: asks (inspection), refuses "new", replaces on request with a backup', async () => {
    const bytes = await exportFromA();
    await writeFolder(b.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'My own tape stop', 1));
    await syncRegistry(b.services.plugins, b.disk.paths.plugins);
    const checked = await inspectBundle(b.services.userPlugins, bytes);
    if (!checked.ok) throw new Error('refused');
    expect(checked.inspection.collision).toMatchObject({ kind: 'different', folder: 'tape-stop', installedVersion: 1, relation: 'newer', isDisabled: false });

    await expect(installBundle(b.services.userPlugins, checked.inspection.bundle, 'new')).rejects.toThrow(/already is a plugin/);
    expect((await readFolder(b.disk.paths.plugins, 'tape-stop'))['index.ts']).toContain('My own tape stop');

    const replaced = await installBundle(b.services.userPlugins, checked.inspection.bundle, 'replace');
    expect(replaced.replaced).toBe(true);
    expect((await readFolder(b.disk.paths.plugins, 'tape-stop'))['index.ts']).toContain("name: 'Tape stop'");
    const backups = await readdir(b.disk.paths.backup);
    expect(backups).toHaveLength(1);
    expect((await readFolder(b.disk.paths.backup, backups[0]!))['index.ts']).toContain('My own tape stop');
  });

  it('installs as a copy under a free id with the id and name rewritten, next to the original', async () => {
    const bytes = await exportFromA();
    await writeFolder(b.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'My own tape stop', 1));
    await syncRegistry(b.services.plugins, b.disk.paths.plugins);
    const checked = await inspectBundle(b.services.userPlugins, bytes);
    if (!checked.ok) throw new Error('refused');
    const first = await installBundle(b.services.userPlugins, checked.inspection.bundle, 'copy');
    expect(first).toMatchObject({ id: 'user.tape-stop-2', folder: 'tape-stop-2', name: 'Tape stop (copy)', loaded: true, presetsAdded: 1 });
    const code = (await readFolder(b.disk.paths.plugins, 'tape-stop-2'))['index.ts']!;
    expect(code).toContain(`'user.tape-stop-2'`);
    expect(code).toContain(`'Tape stop (copy)'`);
    expect(b.services.plugins.get('user.tape-stop')!.name).toBe('My own tape stop');
    const second = await installBundle(b.services.userPlugins, checked.inspection.bundle, 'copy');
    expect(second.id).toBe('user.tape-stop-3');
    expect(second.name).toBe('Tape stop (copy 2)');
  });

  it('recognises the same plugin already installed, and updating keeps the project’s settings', async () => {
    const bytes = await exportFromA();
    const checked = await inspectBundle(b.services.userPlugins, bytes);
    if (!checked.ok) throw new Error('refused');
    await installBundle(b.services.userPlugins, checked.inspection.bundle, 'new');
    const again = await inspectBundle(b.services.userPlugins, bytes);
    expect(again.ok && again.inspection.collision).toMatchObject({ kind: 'identical', folder: 'tape-stop' });
    expect(again.ok && again.inspection.newPresets).toBe(0);

    b.services.history.transact('fx', (d) => void addFxSlot(d, MASTER, makePluginInstance('user.tape-stop', 3, { time: 0.7 })));
    await writeFolder(a.disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop', 4));
    await syncRegistry(a.services.plugins, a.disk.paths.plugins);
    const newer = await inspectBundle(b.services.userPlugins, (await exportBundle(a.services.userPlugins, 'user.tape-stop')).bytes);
    expect(newer.ok && newer.inspection.collision).toMatchObject({ kind: 'different', installedVersion: 3, relation: 'newer' });
    if (!newer.ok) throw new Error('refused');
    await installBundle(b.services.userPlugins, newer.inspection.bundle, 'replace');
    expect(b.services.plugins.get('user.tape-stop')!.version).toBe(4);
    const slot = project(b).mixer.inserts[MASTER]!.fx[0]!;
    expect(slot.plugin).toMatchObject({ pluginId: 'user.tape-stop', pluginVersion: 3, params: { time: 0.7 } });
  });

  it('cannot install without the dev server, but still says what the bundle is', async () => {
    const bytes = await exportFromA();
    const noServer = createTestServices({ pluginServer: pluginServer((() => Promise.reject(new TypeError('offline'))) as typeof fetch) });
    const checked = await inspectBundle(noServer.userPlugins, bytes);
    if (!checked.ok) throw new Error('refused');
    expect(checked.inspection.bundle.manifest.name).toBe('Tape stop');
    expect(checked.inspection.cannotInstall).toMatch(/needs AGstudio's dev server/);
    await expect(installBundle(noServer.userPlugins, checked.inspection.bundle, 'new')).rejects.toThrow(/dev server/);
  });
});

describe('sharing what the plugin builder wrote', () => {
  it('refuses a draft that would not pass the safety checks, before saving anything', async () => {
    const draft = { id: 'user.sneaky', name: 'Sneaky', kind: 'effect' as const, files: [{ path: 'index.ts', content: `fetch('/x'); const id = 'user.sneaky';` }] };
    await expect(shareLooseFiles(draft)).rejects.toMatchObject({ problems: [expect.stringMatching(/network access/)] });
  });
});

describe('duplicate and rename', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await writeFolder(w.disk.paths.plugins, 'tape-stop', {
      'index.ts': `import { ID } from './params';\nimport { defineEffect } from '@agstudio/sdk';\nexport default defineEffect({ id: ID, name: 'Tape stop', version: 1 });\n`,
      'params.ts': `export const ID = 'user.tape-stop';\n`,
    });
    // The stand-in for hot reload reads the id from index.ts; this plugin keeps it in params.ts like the templates do.
    w.services.plugins.sync('user', [
      { path: '/plugins/tape-stop/index.ts', def: { kind: 'effect', id: 'user.tape-stop', name: 'Tape stop', version: 1, params: {}, create: () => ({}) } },
    ]);
    await w.services.userPlugins.refresh();
  });
  afterEach(() => w.disk.cleanup());

  it('duplicates as a new plugin under a free id, leaving the original alone', async () => {
    const copy = await duplicatePlugin(w.services.userPlugins, 'user.tape-stop', 'Tape Stop Deluxe');
    expect(copy).toMatchObject({ id: 'user.tape-stop-deluxe', name: 'Tape Stop Deluxe', folder: 'tape-stop-deluxe' });
    expect((await readFolder(w.disk.paths.plugins, 'tape-stop-deluxe'))['params.ts']).toContain(`'user.tape-stop-deluxe'`);
    expect((await readFolder(w.disk.paths.plugins, 'tape-stop'))['params.ts']).toContain(`'user.tape-stop'`);
  });

  it('renames the id: the project, your presets and chains follow, one undo step, the old folder goes to the trash', async () => {
    const services = w.services;
    const slotId = newId.slot();
    services.history.transact('fx', (d) => void addFxSlot(d, MASTER, makePluginInstance('user.tape-stop', 1, { time: 0.4 }), undefined, slotId));
    services.presets.save({ pluginId: 'user.tape-stop', version: 1, name: 'Slow', params: { time: 2 } });
    services.presets.saveChain({ name: 'Mine', steps: [{ pluginId: 'user.tape-stop', label: 'stop' }] });
    const before = project(w);
    const undoDepth = services.history.status().undoLabel;

    const result = await renamePlugin(services.userPlugins, 'user.tape-stop', 'user.tape-halt');
    expect(result).toMatchObject({ from: 'user.tape-stop', to: 'user.tape-halt', projectPlaces: 1, savedThings: 2 });
    expect(project(w).mixer.inserts[MASTER]!.fx[0]!.plugin).toMatchObject({ pluginId: 'user.tape-halt', params: { time: 0.4 } });
    expect(services.presets.forPlugin('user.tape-halt')).toHaveLength(1);
    expect(services.presets.chains()[0]!.steps[0]!.pluginId).toBe('user.tape-halt');
    expect((await readFolder(w.disk.paths.plugins, 'tape-halt'))['params.ts']).toContain(`'user.tape-halt'`);
    expect(await readdir(w.disk.paths.plugins)).not.toContain('tape-stop');
    expect(services.userPlugins.trashRows().map((t) => t.folder)).toEqual(['tape-stop']);
    expect(services.history.status().undoLabel).toBe('Rename plugin');

    services.history.undo();
    expect(project(w)).toEqual(before);
    expect(services.history.status().undoLabel).toBe(undoDepth);
  });

  it('refuses a new id that is taken or malformed, a plugin that cannot be renamed safely, and changes nothing', async () => {
    const up = w.services.userPlugins;
    await expect(renamePlugin(up, 'user.tape-stop', 'agstudio.stop')).rejects.toThrow(/must look like/);
    await expect(renamePlugin(up, 'user.tape-stop', 'user.tape-stop')).rejects.toThrow(/already its id/);
    await writeFolder(w.disk.paths.plugins, 'other', effectSource('user.other', 'Other'));
    await syncRegistry(w.services.plugins, w.disk.paths.plugins);
    w.services.plugins.sync('user', [
      { path: '/plugins/tape-stop/index.ts', def: { kind: 'effect', id: 'user.tape-stop', name: 'Tape stop', version: 1, params: {}, create: () => ({}) } },
      { path: '/plugins/other/index.ts', def: { kind: 'effect', id: 'user.other', name: 'Other', version: 1, params: {}, create: () => ({}) } },
    ]);
    await up.refresh();
    await expect(renamePlugin(up, 'user.tape-stop', 'user.other')).rejects.toThrow(/already uses/);
    expect(await readdir(w.disk.paths.plugins)).toEqual(expect.arrayContaining(['tape-stop', 'other']));
    expect(await readdir(w.disk.paths.drafts).catch(() => [])).toEqual([]);
    expect(join(w.disk.paths.plugins)).toBeTruthy();
  });
});
