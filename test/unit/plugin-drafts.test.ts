/// <reference types="node" />
import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { checkFiles, draftFolder, renameFolder, scanSource, typeCheck, withForwardSlashes } from '../../tools/ai/drafts.ts';

/** The plugin builder's server-side checks: names, sizes, imports, forbidden APIs, the type check. */
describe('plugin drafts', () => {
  it('accepts user plugin ids only', () => {
    expect(draftFolder('user.tape-stop')).toBe('tape-stop');
    for (const bad of ['agstudio.reverb', 'user.', 'user.Tape', 'user.../x', 'user.a b', 42])
      expect(() => draftFolder(bad)).toThrow();
  });

  it('accepts flat source files with an index', () => {
    const ok = [
      { path: 'index.ts', content: 'export default {};' },
      { path: 'params.ts', content: '' },
      { path: 'dsp.worklet.ts', content: '' },
      { path: 'tape.kernel.ts', content: '' },
      { path: 'README.md', content: '# Tape stop' },
    ];
    expect(checkFiles(ok)).toHaveLength(5);
    // A Faust plugin: index.ts plus its .dsp (Faust code isn't scanned: it can only compute audio).
    expect(checkFiles([{ path: 'index.ts', content: '' }, { path: 'filter.dsp', content: 'process = _;' }])).toHaveLength(2);
    expect(scanSource({ path: 'filter.dsp', content: 'process = _; // fetch(' })).toEqual([]);
    expect(scanSource({ path: 'index.ts', content: `import dsp from './filter.dsp';\nimport { defineFaustEffect } from '@agstudio/sdk/faust';` })).toEqual([]);
    expect(() => checkFiles([{ path: 'params.ts', content: '' }])).toThrow(/index\.ts/);
    expect(() => checkFiles([...ok, { path: '../evil.ts', content: '' }])).toThrow(/allowed file name/);
    expect(() => checkFiles([...ok, { path: 'tsconfig.json', content: '' }])).toThrow(/allowed file name/);
    expect(() => checkFiles([...ok, { path: 'run.sh', content: '' }])).toThrow(/allowed file name/);
    expect(() => checkFiles([...ok, { path: 'INDEX.ts', content: '' }])).toThrow(/twice/);
    expect(() => checkFiles([{ path: 'index.ts', content: 'x'.repeat(70_000) }])).toThrow(/too large/);
  });

  it('allows the SDK, react and the plugin’s own files, nothing else', () => {
    const main = {
      path: 'index.ts',
      content: `import { defineEffect, p } from '@agstudio/sdk';
import { Knob } from '@agstudio/sdk/ui';
import { useState } from 'react';
import processor from './dsp.worklet.ts?worker&url';
import { params } from './params';
export { other } from './other';`,
    };
    expect(scanSource(main)).toEqual([]);
    expect(scanSource({ path: 'index.ts', content: `import { readFile } from 'node:fs';` })[0]).toMatch(/node:fs/);
    expect(scanSource({ path: 'index.ts', content: `import { services } from '@app/services';` })[0]).toMatch(/@app/);
    expect(scanSource({ path: 'index.ts', content: `import x from '../other/thing';` })[0]).toMatch(/other\/thing/);
    // Audio-thread files get the worklet SDK only.
    expect(scanSource({ path: 'dsp.worklet.ts', content: `import { EffectKernel } from '@agstudio/sdk/worklet';` })).toEqual(
      [],
    );
    expect(scanSource({ path: 'dsp.worklet.ts', content: `import { useState } from 'react';` })[0]).toMatch(/react/);
  });

  it('refuses network, storage and eval in code, but not in comments or strings', () => {
    const uses = (content: string) => scanSource({ path: 'index.ts', content });
    expect(uses(`fetch('https://x.example')`)[0]).toMatch(/network/);
    expect(uses(`const ws = new WebSocket(url)`)[0]).toMatch(/network/);
    expect(uses(`eval(code)`)[0]).toMatch(/eval/);
    expect(uses(`localStorage.setItem('a', 'b')`)[0]).toMatch(/storage/);
    expect(uses(`await import('./x')`)[0]).toMatch(/dynamic import/);
    expect(uses(`// we never fetch() anything\nconst label = 'eval(';`)).toEqual([]);
  });

  describe('on Windows', () => {
    it('writes relative paths for tsconfig files with forward slashes', () => {
      expect(withForwardSlashes(['..', '..', '..', 'tsconfig.base.json'].join(sep))).toBe('../../../tsconfig.base.json');
    });

    const busy = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

    it('tries a rename again while the folder is briefly busy (a file watcher or scanner holds it)', async () => {
      const calls: string[] = [];
      const pauses: number[] = [];
      const move = async (from: string, to: string) => {
        calls.push(`${from}>${to}`);
        if (calls.length < 3) throw busy;
      };
      await renameFolder('a', 'b', move, async (ms) => void pauses.push(ms));
      expect(calls).toHaveLength(3);
      expect(pauses).toEqual([120, 240]);
    });

    it('gives up after a few tries, and does not retry an error that will not go away', async () => {
      let tries = 0;
      const always = async () => {
        tries++;
        throw busy;
      };
      await expect(renameFolder('a', 'b', always, async () => {})).rejects.toBe(busy);
      expect(tries).toBe(6);
      const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      tries = 0;
      await expect(
        renameFolder('a', 'b', async () => {
          tries++;
          throw missing;
        }, async () => {}),
      ).rejects.toBe(missing);
      expect(tries).toBe(1);
    });
  });

  describe('type check', () => {
    const root = process.cwd();
    const dir = join(root, 'plugins', '_drafts', 'vitest-check');
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it('passes a correct plugin and reports errors with file and line', async () => {
      await mkdir(dir, { recursive: true });
      const template = await readFile(join(root, 'templates', 'effect-graph', 'index.ts'), 'utf8');
      await writeFile(join(dir, 'index.ts'), template.replace(/__PLUGIN_ID__/g, 'user.vitest-check'));
      expect(await typeCheck(root, dir)).toEqual([]);
      await writeFile(join(dir, 'index.ts'), `const n: number = 'not a number';\nexport default n;\n`);
      const problems = await typeCheck(root, dir);
      expect(problems[0]).toMatch(/^index\.ts:1:7 TS2322: /);
    }, 120_000);
  });
});
