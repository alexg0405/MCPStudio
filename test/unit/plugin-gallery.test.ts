/// <reference types="node" />
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { galleryBundle, loadGallery, type GalleryItem } from '@app/plugins/gallery';
import { inspectBundle, installBundle } from '@app/plugins/bundle-install';
import { PluginRegistry } from '@app/plugins/registry';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { createTestServices } from '@app/testing';
import { readBundle } from '@core/plugin-bundle/bundle';
import { pluginCapabilities } from '@core/plugin-bundle/capabilities';
import { typeCheck } from '../../tools/plugins/typecheck.ts';
import { compileFaust } from '../../tools/faust/compile.ts';
import { folderServer, readFolder, tempPlugins, type TempPlugins } from '../helpers/plugin-folder';

/** The gallery: example plugins that install with one click, through the same checks as any bundle. */
const gallery = await loadGallery();

describe('the gallery', () => {
  it('has a tape stop, a bitcrusher, an FM bell and a Faust filter, each with its own id and a description', () => {
    expect(gallery.map((item) => item.name)).toEqual(['Bit Crusher', 'FM Bell', 'Tape Stop', 'Wobble Filter']);
    expect(gallery.map((item) => [item.kind, item.folder])).toEqual([
      ['effect', 'bit-crusher'],
      ['instrument', 'fm-bell'],
      ['effect', 'tape-stop'],
      ['effect', 'wobble-filter'],
    ]);
    const ids = gallery.map((item) => item.id);
    expect(new Set(ids).size).toBe(4);
    for (const item of gallery) {
      expect(item.id).toBe(`user.${item.folder}`);
      expect(item.description.length).toBeGreaterThan(20);
      expect(item.author).toBe('AGstudio');
      expect(item.files.some((file) => file.path === 'README.md')).toBe(true);
    }
  });

  it('does not use an id of the plugins that live in the repository’s plugins/ folder', async () => {
    const own = await readdir(join(process.cwd(), 'plugins'));
    for (const item of gallery) expect(own).not.toContain(item.folder);
  });

  it('packs every item into a bundle that passes every check and says what it can do', async () => {
    for (const item of gallery) {
      const read = await readBundle(await galleryBundle(item));
      if (!read.ok) throw new Error(`${item.name}: ${read.problems.join('; ')}`);
      expect(read.bundle.manifest).toMatchObject({ id: item.id, name: item.name, kind: item.kind, version: item.version });
      expect(read.bundle.files).toEqual(item.files);
      expect(pluginCapabilities(item.kind, read.bundle.files).can.length).toBeGreaterThan(1);
    }
  });

  it('has Faust code that compiles', async () => {
    const wobble = gallery.find((item) => item.folder === 'wobble-filter') as GalleryItem;
    const dsp = wobble.files.find((file) => file.path === 'filter.dsp')!;
    const compiled = await compileFaust('filter', dsp.content);
    expect(compiled.meta.ui.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('installing from the gallery', () => {
  let disk: TempPlugins | null = null;
  afterEach(async () => {
    await disk?.cleanup();
    disk = null;
  });

  async function install(item: GalleryItem, check?: () => Promise<string[]>) {
    disk = await tempPlugins();
    const registry = new PluginRegistry();
    registerBuiltinPlugins(registry);
    const services = createTestServices({ plugins: registry, pluginServer: folderServer(disk.paths, registry, check ? { typeCheck: check } : {}) });
    const inspected = await inspectBundle(services.userPlugins, await galleryBundle(item));
    if (!inspected.ok) throw new Error(inspected.problems.join('; '));
    return { services, result: await installBundle(services.userPlugins, inspected.inspection.bundle, 'new') };
  }

  it('installs each plugin into plugins/<folder> with its files and loads it', async () => {
    for (const item of gallery) {
      const { result } = await install(item);
      expect(result).toMatchObject({ id: item.id, folder: item.folder, loaded: true, replaced: false });
      expect(Object.keys(await readFolder(disk!.paths.plugins, item.folder)).sort()).toEqual(item.files.map((file) => file.path).sort());
      await disk!.cleanup();
    }
    disk = null;
  });

  it('passes the real TypeScript check on the dev server’s path (a worklet plugin and a Faust one)', async () => {
    // The check needs the repository's node_modules to find the SDK's types, so the temporary folder lives inside it.
    const scratch = await mkdtemp(join(process.cwd(), 'node_modules', '.tmp-gallery-check-'));
    try {
      for (const folder of ['tape-stop', 'wobble-filter', 'fm-bell']) {
        const item = gallery.find((candidate) => candidate.folder === folder) as GalleryItem;
        const dir = join(scratch, folder);
        await mkdir(dir);
        for (const file of item.files) await writeFile(join(dir, file.path), file.content);
        expect(await typeCheck(process.cwd(), dir), folder).toEqual([]);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
