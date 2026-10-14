/// <reference types="node" />
import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkFiles, draftFolder, scanSource, typeCheck } from '../../tools/ai/drafts.ts';

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
