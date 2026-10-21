import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { createEmptyProject } from '../model/defaults';
import { readBundle, writeBundle } from '../plugin-bundle/bundle';
import { readProjectFile, readProjectFileIndex, writeProjectFile, writeProjectFileStream } from './project-file';
import { bytesReader } from './zip-index';

const NOW = new Date('2026-10-12T10:30:00.000Z');
const PROJECT = createEmptyProject();
const CODE = `import { defineEffect } from '@agstudio/sdk';\nexport default defineEffect({ id: 'user.tape-stop', name: 'Tape stop' });\n`;

const bundle = () =>
  writeBundle({ id: 'user.tape-stop', name: 'Tape stop', version: 1, kind: 'effect', files: [{ path: 'index.ts', content: CODE }] });

async function streamed(plugins?: Map<string, Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  await writeProjectFileStream({ project: PROJECT, view: null, samples: [], plugins, appVersion: 'test', now: NOW }, async (b) => void parts.push(b));
  return new Uint8Array(Buffer.concat(parts));
}

describe('projects that carry their plugins', () => {
  it('embeds the bundles the musician chose and gives back the same bytes (written whole)', async () => {
    const packed = await bundle();
    const file = writeProjectFile({ project: PROJECT, view: null, samples: new Map(), plugins: new Map([['user.tape-stop', packed]]), appVersion: 'test', now: NOW });
    expect(Object.keys(unzipSync(file)).sort()).toEqual(['meta.json', 'plugins/user.tape-stop.agplugin', 'project.json', 'view.json']);
    const opened = readProjectFile(file);
    expect([...opened.plugins.keys()]).toEqual(['user.tape-stop']);
    expect(Buffer.from(opened.plugins.get('user.tape-stop')!).equals(Buffer.from(packed))).toBe(true);
    expect(opened.project).toEqual(PROJECT);
    // The embedded copy is a real bundle: it passes every check on the way out.
    expect((await readBundle(opened.plugins.get('user.tape-stop')!)).ok).toBe(true);
  });

  it('gives the same result written a piece at a time and read a range at a time', async () => {
    const packed = await bundle();
    const file = await streamed(new Map([['user.tape-stop', packed]]));
    const whole = readProjectFile(file);
    const indexed = await readProjectFileIndex(bytesReader(file), file.length);
    expect([...indexed.plugins.keys()]).toEqual([...whole.plugins.keys()]);
    expect(Buffer.from(indexed.plugins.get('user.tape-stop')!).equals(Buffer.from(packed))).toBe(true);
  });

  it('embeds nothing unless asked: a project without plugins reads as before', async () => {
    const file = writeProjectFile({ project: PROJECT, view: null, samples: new Map(), appVersion: 'test', now: NOW });
    expect(Object.keys(unzipSync(file)).some((name) => name.startsWith('plugins/'))).toBe(false);
    expect(readProjectFile(file).plugins.size).toBe(0);
    expect((await readProjectFileIndex(bytesReader(file), file.length)).plugins.size).toBe(0);
  });

  it('refuses to write an id that is not a user plugin, and ignores entries that are not named like one when reading', async () => {
    expect(() => writeProjectFile({ project: PROJECT, view: null, samples: new Map(), plugins: new Map([['../evil', new Uint8Array(4)]]), appVersion: 'test' })).toThrow(/not a user plugin id/);
    const base = unzipSync(writeProjectFile({ project: PROJECT, view: null, samples: new Map(), appVersion: 'test', now: NOW }));
    const odd = zipSync({ ...base, 'plugins/../x.agplugin': strToU8('x'), 'plugins/agstudio.eq.agplugin': strToU8('x'), 'plugins/user.ok-one.agplugin': strToU8('x') });
    expect([...readProjectFile(odd).plugins.keys()]).toEqual(['user.ok-one']);
  });

  it('a damaged embedded bundle never stops the project from opening: it fails only when read as a bundle', async () => {
    const odd = zipSync({ ...unzipSync(writeProjectFile({ project: PROJECT, view: null, samples: new Map(), appVersion: 'test', now: NOW })), 'plugins/user.broken.agplugin': strToU8('not a zip') });
    const opened = readProjectFile(odd);
    expect(opened.project).toEqual(PROJECT);
    expect((await readBundle(opened.plugins.get('user.broken')!)).ok).toBe(false);
  });
});
