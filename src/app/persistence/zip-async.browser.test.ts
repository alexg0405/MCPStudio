import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@core/io/hash';
import {
  projectFileParts,
  readProjectFile,
  writeProjectFile,
  type EmbeddedSample,
  type WriteProjectFileInput,
} from '@core/io/project-file';
import { createEmptyProject } from '@core/model/defaults';
import { writeProjectFileOffThread, zipOffThread } from './zip-async';

async function input(withSample: boolean): Promise<WriteProjectFileInput> {
  const project = createEmptyProject({ title: 'A song with “unicode” ♪ '.repeat(40), now: new Date(0) });
  const samples = new Map<string, EmbeddedSample>();
  if (withSample) {
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) % 251);
    samples.set(await sha256Hex(bytes), { ext: 'wav', bytes });
  }
  return {
    project,
    view: { windows: Array.from({ length: 200 }, (_, i) => ({ i, name: `w${i}` })) },
    samples,
    appVersion: '0.1.0',
    now: new Date('2026-10-12T12:00:00.000Z'),
  };
}

const sizes = (files: Record<string, unknown>) =>
  Object.values(files).map((e) => (Array.isArray(e) ? (e[0] as Uint8Array) : (e as Uint8Array)).byteLength);

describe('writeProjectFileOffThread in a browser (a real Worker)', () => {
  it('has Workers here, so this is the off-thread path', () => {
    expect(typeof Worker).toBe('function');
  });

  it('gives the same bytes as writeProjectFile, and reads back identically', async () => {
    for (const withSample of [false, true]) {
      const inp = await input(withSample);
      const sync = writeProjectFile(inp);
      const off = await writeProjectFileOffThread(inp);
      expect(off.length).toBe(sync.length);
      expect(off.every((b, i) => b === sync[i])).toBe(true);
      const a = readProjectFile(sync);
      const b = readProjectFile(off);
      expect(b.project).toEqual(a.project);
      expect(b.view).toEqual(a.view);
      expect([...b.samples.keys()]).toEqual([...a.samples.keys()]);
    }
  });

  it('leaves the caller’s buffers alone (they are cloned, not transferred)', async () => {
    const parts = projectFileParts(await input(true));
    const before = sizes(parts.files);
    await zipOffThread(parts);
    expect(sizes(parts.files)).toEqual(before);
    expect(before.every((n) => n > 0)).toBe(true);
  });
});
