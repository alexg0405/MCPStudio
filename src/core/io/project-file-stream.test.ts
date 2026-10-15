import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../model/defaults';
import { sha256Hex } from './hash';
import { ProjectFileError, readProjectFile, readProjectFileIndex, writeProjectFile, writeProjectFileStream } from './project-file';
import { bytesReader } from './zip-index';

const NOW = new Date('2026-10-12T10:30:00.000Z');
const VIEW = { mode: 'song', windows: { mixer: { visible: true } } };
const PROJECT = createEmptyProject();

/** Pseudo-random bytes (incompressible, like audio), `n` long. */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

async function streamed(samples: Array<{ bytes: Uint8Array | null; ext: string; hash?: string }>) {
  const parts: Uint8Array[] = [];
  const sources = await Promise.all(
    samples.map(async (s) => ({ hash: s.hash ?? (await sha256Hex(s.bytes!)), ext: s.ext, read: async () => (s.bytes ? { bytes: s.bytes } : null) })),
  );
  let reads = 0;
  const { missing } = await writeProjectFileStream(
    {
      project: PROJECT,
      view: VIEW,
      samples: sources.map((s) => ({ ...s, read: () => (reads++, s.read()) })),
      appVersion: 'test',
      now: NOW,
    },
    async (b) => {
      parts.push(b);
    },
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out, missing, reads, sources };
}

describe('project files a piece at a time', () => {
  it('writes a zip both readers open, with every sample (a 3 MB one in pieces) and none missing', async () => {
    const big = noise(3 * 1024 * 1024 + 17, 1);
    const small = noise(1000, 2);
    const { bytes, missing, reads, sources } = await streamed([
      { bytes: big, ext: 'wav' },
      { bytes: small, ext: 'MP3' },
      { bytes: small, ext: 'mp3' }, // the same sample twice: stored once
    ]);
    expect(missing).toEqual([]);
    expect(reads).toBe(2);
    const whole = readProjectFile(bytes);
    expect(whole.project).toEqual(readProjectFile(writeProjectFile({ project: PROJECT, view: VIEW, samples: new Map(), appVersion: 'test', now: NOW })).project);
    expect(whole.view).toEqual(VIEW);
    expect(whole.meta.savedAt).toBe(NOW.toISOString());
    expect(await sha256Hex(whole.samples.get(sources[0]!.hash)!.bytes)).toBe(sources[0]!.hash);
    const index = await readProjectFileIndex(bytesReader(bytes), bytes.length);
    expect(index.project).toEqual(whole.project);
    expect(index.view).toEqual(VIEW);
    expect([...index.samples.keys()].sort()).toEqual([...whole.samples.keys()].sort());
    const lazy = index.samples.get(sources[0]!.hash)!;
    expect(lazy).toMatchObject({ ext: 'wav', size: big.length });
    // Comparing 3 MB element by element is slow in expect(): compare hashes.
    expect(await sha256Hex(await lazy.read())).toBe(sources[0]!.hash);
    expect(await index.samples.get(sources[1]!.hash)!.read()).toEqual(small);
  });

  it('leaves out samples whose bytes are missing and says which', async () => {
    const hash = 'a'.repeat(64);
    const { bytes, missing } = await streamed([{ bytes: null, ext: 'wav', hash }]);
    expect(missing).toEqual([hash]);
    expect(readProjectFile(bytes).samples.size).toBe(0);
  });

  it('reads files written in one piece, and refuses what is no project file', async () => {
    const sample = noise(5000, 3);
    const hash = await sha256Hex(sample);
    const bytes = writeProjectFile({ project: createEmptyProject(), view: VIEW, samples: new Map([[hash, { ext: 'flac', bytes: sample }]]), appVersion: '1', now: NOW });
    const index = await readProjectFileIndex(bytesReader(bytes), bytes.length);
    expect(await index.samples.get(hash)!.read()).toEqual(sample);
    const junk = noise(100, 4);
    await expect(readProjectFileIndex(bytesReader(junk), junk.length)).rejects.toBeInstanceOf(ProjectFileError);
    const cut = bytes.subarray(0, bytes.length - 30);
    await expect(readProjectFileIndex(bytesReader(cut), cut.length)).rejects.toMatchObject({ code: 'damaged' });
  });
});
