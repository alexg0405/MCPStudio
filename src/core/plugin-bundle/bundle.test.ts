import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { sha256Hex } from '../io/hash';
import { readBundle, writeBundle, type BundleInput } from './bundle';
import { pluginCapabilities } from './capabilities';
import { isValidSdkRange, sdkInRange } from './sdk-range';
import { declaresPluginId, withPluginId, type PluginFile } from './rules';

const INDEX = `import { defineEffect } from '@agstudio/sdk';\nexport default defineEffect({ id: 'user.tape-stop', name: 'Tape stop' });\n`;

const input = (over: Partial<BundleInput> = {}): BundleInput => ({
  id: 'user.tape-stop',
  name: 'Tape stop',
  version: 2,
  kind: 'effect',
  author: 'Alex',
  description: 'Slows the sound down to a stop.',
  files: [
    { path: 'index.ts', content: INDEX },
    { path: 'README.md', content: '# Tape stop\n' },
  ],
  presets: [
    { name: 'Slow', version: 2, params: { time: 1.5, hold: true, curve: 'exp' } },
    { name: 'Fast', version: 2, params: { time: 0.2, hold: false, curve: 'lin' }, state: { a: [1, 2] } },
  ],
  ...over,
});

const sorted = (files: readonly PluginFile[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));

/** A hand-made zip with a correct manifest for `files`, to test what the reader refuses. */
async function craft(
  files: Record<string, string>,
  edit: (manifest: Record<string, unknown>, zip: Zippable) => void = () => {},
): Promise<Uint8Array> {
  const zip: Zippable = {};
  const listed: { path: string; sha256: string; bytes: number }[] = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes = strToU8(content);
    zip[`files/${path}`] = bytes;
    listed.push({ path, sha256: await sha256Hex(bytes), bytes: bytes.length });
  }
  const manifest: Record<string, unknown> = {
    format: 'agstudio-plugin',
    formatVersion: 1,
    id: 'user.tape-stop',
    name: 'Tape stop',
    version: 1,
    kind: 'effect',
    sdk: '^1.0.0',
    files: listed,
  };
  edit(manifest, zip);
  zip['agplugin.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(zip);
}

const problemsOf = async (bytes: Uint8Array): Promise<string> => {
  const result = await readBundle(bytes);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.problems.join(' | ');
};

describe('plugin bundles', () => {
  it('round trips the files and presets exactly', async () => {
    const bytes = await writeBundle(input());
    const result = await readBundle(bytes);
    if (!result.ok) throw new Error(result.problems.join('; '));
    expect(sorted(result.bundle.files)).toEqual(sorted(input().files));
    expect(result.bundle.presets).toEqual(input().presets);
    expect(result.bundle.manifest).toMatchObject({ id: 'user.tape-stop', name: 'Tape stop', version: 2, kind: 'effect', author: 'Alex' });
    expect(result.bundle.manifest.files.map((f) => f.path)).toEqual(['index.ts', 'README.md']);
  });

  it('writes the same bytes for the same plugin', async () => {
    const [a, b] = [await writeBundle(input()), await writeBundle(input())];
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('works without presets', async () => {
    const result = await readBundle(await writeBundle(input({ presets: [] })));
    expect(result.ok && result.bundle.presets).toEqual([]);
    expect(Object.keys(unzipSync(await writeBundle(input({ presets: [] }))))).not.toContain('presets.json');
  });

  describe('refuses', () => {
    it('a file that is not a zip, and a zip that is not a bundle', async () => {
      expect(await problemsOf(strToU8('hello world, this is not a zip file at all'))).toMatch(/not a zip/);
      expect(await problemsOf(zipSync({ 'readme.txt': strToU8('hi') }))).toMatch(/does not belong/);
      expect(await problemsOf(zipSync({ 'files/index.ts': strToU8(INDEX) }))).toMatch(/no manifest/);
    });

    it('a bundle that is too big', async () => {
      expect(await problemsOf(new Uint8Array(2 * 1024 * 1024))).toMatch(/too large/);
    });

    it('a manifest that is not valid', async () => {
      for (const [change, pattern] of [
        [{ id: 'agstudio.reverb' }, /id must look like/],
        [{ id: 'user.Bad Id' }, /id must look like/],
        [{ name: '' }, /needs a name/],
        [{ version: 0 }, /whole number/],
        [{ version: 1.5 }, /whole number/],
        [{ kind: 'drum' }, /kind must be/],
        [{ sdk: 'banana' }, /sdk must be/],
        [{ files: [] }, /lists no files/],
        [{ files: [{ path: 'index.ts' }] }, /path, a SHA-256/],
      ] as [Record<string, unknown>, RegExp][]) {
        const bytes = await craft({ 'index.ts': INDEX }, (manifest) => Object.assign(manifest, change));
        expect(await problemsOf(bytes)).toMatch(pattern);
      }
    });

    it('a bundle from a newer format', async () => {
      const bytes = await craft({ 'index.ts': INDEX }, (manifest) => (manifest.formatVersion = 99));
      expect(await problemsOf(bytes)).toMatch(/newer AGstudio/);
    });

    it('a wrong SDK range', async () => {
      const bytes = await craft({ 'index.ts': INDEX }, (manifest) => (manifest.sdk = '^2.0.0'));
      expect(await problemsOf(bytes)).toMatch(/written for SDK \^2\.0\.0/);
    });

    it('code that uses forbidden APIs, imports outside the SDK, or is the wrong shape', async () => {
      const bad = (code: string) => craft({ 'index.ts': `${INDEX}${code}\n` });
      expect(await problemsOf(await bad(`fetch('https://example.com');`))).toMatch(/network access/);
      expect(await problemsOf(await bad(`localStorage.setItem('a', 'b');`))).toMatch(/browser storage/);
      expect(await problemsOf(await bad(`eval('1');`))).toMatch(/eval/);
      expect(await problemsOf(await bad(`import('./x');`))).toMatch(/dynamic import/);
      expect(await problemsOf(await bad(`import fs from 'node:fs';`))).toMatch(/may not import "node:fs"/);
      expect(await problemsOf(await craft({ 'params.ts': 'export {};' }))).toMatch(/needs an index\.ts/);
      expect(await problemsOf(await craft({ 'index.ts': INDEX, 'run.sh': 'rm -rf /' }))).toMatch(/not an allowed file name/);
    });

    it('nested folders and entries outside files/', async () => {
      const nested = await craft({ 'index.ts': INDEX }, (_manifest, zip) => (zip['files/sub/evil.ts'] = strToU8('export {};')));
      expect(await problemsOf(nested)).toMatch(/must be flat/);
      const outside = await craft({ 'index.ts': INDEX }, (_manifest, zip) => (zip['../evil.ts'] = strToU8('export {};')));
      expect(await problemsOf(outside)).toMatch(/must be flat/);
    });

    it('a file that is too big, too many files, a total that is too big', async () => {
      const big = `${INDEX}// ${'x'.repeat(70_000)}\n`;
      expect(await problemsOf(await craft({ 'index.ts': big }))).toMatch(/too large/);
      const many: Record<string, string> = { 'index.ts': INDEX };
      for (let i = 0; i < 9; i++) many[`f${i}.ts`] = 'export {};';
      expect(await problemsOf(await craft(many))).toMatch(/at most 8 files/);
      const heavy: Record<string, string> = { 'index.ts': INDEX };
      for (let i = 0; i < 5; i++) heavy[`h${i}.ts`] = `// ${'y'.repeat(60_000)}\nexport {};`;
      expect(await problemsOf(await craft(heavy))).toMatch(/too large/);
    });

    it('files that do not match their hashes, and files the manifest does not list', async () => {
      const tampered = await craft({ 'index.ts': INDEX }, (_manifest, zip) => (zip['files/index.ts'] = strToU8(`${INDEX}// edited\n`)));
      expect(await problemsOf(tampered)).toMatch(/does not match its hash/);
      const extra = await craft({ 'index.ts': INDEX }, (_manifest, zip) => (zip['files/extra.ts'] = strToU8('export {};')));
      expect(await problemsOf(extra)).toMatch(/not in its manifest/);
      const missing = await craft({ 'index.ts': INDEX }, (_manifest, zip) => delete zip['files/index.ts']);
      expect(await problemsOf(missing)).toMatch(/missing from the bundle/);
    });

    it('a manifest that disagrees with the code about the id', async () => {
      const bytes = await craft({ 'index.ts': INDEX }, (manifest) => (manifest.id = 'user.other-name'));
      expect(await problemsOf(bytes)).toMatch(/never says its id/);
    });

    it('presets that are damaged, unlisted or not valid', async () => {
      const good = await writeBundle(input());
      const entries = unzipSync(good);
      const edited = (presets: unknown) => zipSync({ ...entries, 'presets.json': strToU8(JSON.stringify(presets)) });
      expect(await problemsOf(edited([{ name: 'Slow', version: 2, params: {} }]))).toMatch(/do not match their hash/);
      const unlisted = await craft({ 'index.ts': INDEX }, (_manifest, zip) => (zip['presets.json'] = strToU8('[]')));
      expect(await problemsOf(unlisted)).toMatch(/presets its manifest does not list/);
      const badPresets = [{ name: 'x', version: 1, params: { a: { nested: true } } }];
      const bytes = strToU8(JSON.stringify(badPresets));
      const invalid = await craft({ 'index.ts': INDEX }, (manifest, zip) => {
        zip['presets.json'] = bytes;
        manifest.presets = { count: 1, sha256: '0'.repeat(64) };
      });
      expect(await problemsOf(invalid)).toMatch(/do not match their hash/);
    });
  });

  it('says what a plugin can and cannot do in plain words', () => {
    const caps = pluginCapabilities('effect', [
      { path: 'index.ts', content: INDEX },
      { path: 'dsp.worklet.ts', content: '' },
      { path: 'panel.tsx', content: '' },
      { path: 'voice.dsp', content: '' },
    ]);
    expect(caps.can.join(' ')).toMatch(/audio thread/);
    expect(caps.can.join(' ')).toMatch(/Faust/);
    expect(caps.can.join(' ')).toMatch(/own panel/);
    expect(caps.cannot.join(' ')).toMatch(/network/);
    expect(caps.caution).toMatch(/not a sandbox/);
  });
});

describe('sdk ranges', () => {
  it('matches the versions a plugin was written for', () => {
    expect(sdkInRange('^1.0.0', '1.4.2')).toBe(true);
    expect(sdkInRange('^1.2.0', '1.1.0')).toBe(false);
    expect(sdkInRange('^1.0.0', '2.0.0')).toBe(false);
    expect(sdkInRange('~1.2.0', '1.2.9')).toBe(true);
    expect(sdkInRange('~1.2.0', '1.3.0')).toBe(false);
    expect(sdkInRange('>=1.0.0 <2.0.0', '1.9.9')).toBe(true);
    expect(sdkInRange('>=1.0.0 <1.0.0', '1.0.0')).toBe(false);
    expect(sdkInRange('1.x', '1.7.0')).toBe(true);
    expect(sdkInRange('*', '9.9.9')).toBe(true);
    expect(sdkInRange('1.0.0', '1.0.0')).toBe(true);
    expect(sdkInRange('^0.2.0', '0.3.0')).toBe(false);
  });

  it('uses this AGstudio’s SDK by default and refuses what it can’t read', () => {
    expect(sdkInRange('^1.0.0')).toBe(true);
    expect(sdkInRange('^2.0.0')).toBe(false);
    for (const bad of ['', 'banana', '^1', '>=', 42, null, 'x'.repeat(100)]) expect(isValidSdkRange(bad)).toBe(false);
  });
});

describe('plugin ids in code', () => {
  const files: PluginFile[] = [
    { path: 'params.ts', content: `export const ID = 'user.old-name';\nconst other = "user.old-name-2";` },
    { path: 'index.ts', content: 'import { ID } from "./params";' },
    { path: 'README.md', content: 'user.old-name' },
  ];

  it('is found and rewritten only where the code spells it whole', () => {
    expect(declaresPluginId(files, 'user.old-name')).toBe(true);
    expect(declaresPluginId(files, 'user.nothing')).toBe(false);
    const renamed = withPluginId(files, 'user.old-name', 'user.new-name');
    expect(renamed.changes).toBe(1);
    expect(renamed.files[0]!.content).toContain(`'user.new-name'`);
    expect(renamed.files[0]!.content).toContain('"user.old-name-2"');
    expect(renamed.files[2]!.content).toBe('user.old-name');
  });
});
