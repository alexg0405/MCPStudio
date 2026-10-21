/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { MASTER } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addFxSlot } from '@core/ops/mixer';
import { readBundle } from '@core/plugin-bundle/bundle';
import { buildProjectFile } from '../persistence/project-io';
import { createMemoryBlobStore } from '../persistence/blob-store';
import { effectSource, folderServer, syncRegistry, tempPlugins, writeFolder, type TempPlugins } from '../../../test/helpers/plugin-folder';
import { registerBuiltinPlugins } from './discover';
import { packPlugins, usedUserPlugins } from './project-plugins';
import { PluginRegistry } from './registry';
import { createTestServices } from '../testing';

/** A song that uses the user effect "tape-stop" and one built-in, on a computer that may or may not have the plugin. */
async function world() {
  const disk = await tempPlugins();
  const registry = new PluginRegistry();
  registerBuiltinPlugins(registry);
  const services = createTestServices({ plugins: registry, pluginServer: folderServer(disk.paths, registry) });
  services.history.transact('Use plugins', (d) => {
    addFxSlot(d, MASTER, makePluginInstance('user.tape-stop', 1, { time: 0.4 }));
    addChannel(d, makeInstrumentChannel('Lead', makePluginInstance('agstudio.pluck', 1, {})));
  });
  return { disk, services, registry };
}

const asFile = (bytes: Uint8Array, name: string) => new File([bytes.slice().buffer], name);

describe('a project that uses a plugin this computer does not have', () => {
  let disk: TempPlugins;
  beforeEach(async () => void (disk = await tempPlugins()));
  afterEach(() => disk.cleanup());

  it('says which plugin is missing and where the song uses it, and not about built-ins or installed ones', async () => {
    const { services, disk: own } = await world();
    const bytes = await buildProjectFile(services.doc.getState().project, null, 'test', { store: createMemoryBlobStore() });
    await own.cleanup();

    const other = createTestServices();
    const missing = vi.fn();
    other.files.setUi({ pluginsMissing: missing, askUnsaved: async () => 'discard' });
    expect(await other.files.openFile(asFile(bytes, 'Song.agproj'))).toBe(true);
    expect(missing).toHaveBeenCalledOnce();
    const info = missing.mock.calls[0]![0] as { name: string; missing: Map<string, { inserts: unknown[] }>; embedded: Map<string, unknown> };
    expect(info.name).toBe('Song');
    expect([...info.missing.keys()]).toEqual(['user.tape-stop']);
    expect(info.missing.get('user.tape-stop')!.inserts).toHaveLength(1);
    expect(info.embedded.size).toBe(0);
  });

  it('stays quiet when every plugin is installed', async () => {
    const { services, registry, disk: own } = await world();
    await writeFolder(own.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop'));
    await syncRegistry(registry, own.paths.plugins);
    const bytes = await buildProjectFile(services.doc.getState().project, null, 'test', { store: createMemoryBlobStore() });
    const missing = vi.fn();
    services.files.setUi({ pluginsMissing: missing, askUnsaved: async () => 'discard' });
    await services.files.openFile(asFile(bytes, 'Song.agproj'));
    expect(missing).not.toHaveBeenCalled();
    await own.cleanup();
  });

  it('hands over the bundles the file carries, and the packed plugin installs on the other computer', async () => {
    const { services, registry, disk: own } = await world();
    await writeFolder(own.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'Tape stop'));
    await syncRegistry(registry, own.paths.plugins);
    await services.userPlugins.refresh();
    const used = usedUserPlugins(services.userPlugins);
    expect(used.map((u) => u.row.id)).toEqual(['user.tape-stop']);
    const packed = await packPlugins(services.userPlugins, used.map((u) => u.row.id));
    expect(packed.failed).toEqual([]);
    const bytes = await buildProjectFile(services.doc.getState().project, null, 'test', { store: createMemoryBlobStore(), plugins: packed.bundles });

    const friend = createTestServices();
    const missing = vi.fn();
    friend.files.setUi({ pluginsMissing: missing, askUnsaved: async () => 'discard' });
    await friend.files.openFile(asFile(bytes, 'Shared.agproj'));
    const info = missing.mock.calls[0]![0] as { embedded: Map<string, Uint8Array> };
    expect([...info.embedded.keys()]).toEqual(['user.tape-stop']);
    const read = await readBundle(info.embedded.get('user.tape-stop')!);
    expect(read.ok && read.bundle.files[0]!.content).toContain(`id: 'user.tape-stop'`);
    await own.cleanup();
  });

  it('reports a plugin that cannot be packed instead of failing the whole save', async () => {
    const { services, registry, disk: own } = await world();
    await writeFolder(own.paths.plugins, 'tape-stop', { 'index.ts': `fetch('/x'); export default { id: 'user.tape-stop', name: 'Tape stop', version: 1 };` });
    registry.sync('user', [{ path: '/plugins/tape-stop/index.ts', def: { kind: 'effect', id: 'user.tape-stop', name: 'Tape stop', version: 1, params: {}, create: () => ({}) } }]);
    await services.userPlugins.refresh();
    const packed = await packPlugins(services.userPlugins, ['user.tape-stop']);
    expect(packed.bundles.size).toBe(0);
    expect(packed.failed).toMatchObject([{ name: 'Tape stop', reason: expect.stringMatching(/safety checks/) }]);
    await own.cleanup();
  });

  it('Save As offers to carry plugins first, and a cancel there cancels the save', async () => {
    const services = createTestServices();
    const choose = vi.fn(async () => null);
    services.files.setUi({ chooseEmbeddedPlugins: choose });
    expect(await services.files.saveAs()).toBe(false);
    expect(choose).toHaveBeenCalledOnce();
  });
});
