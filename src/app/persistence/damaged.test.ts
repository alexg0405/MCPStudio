import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProjectFileError, readProjectFile, writeProjectFile } from '@core/io/project-file';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { createEmptyProject } from '@core/model/defaults';
import { createMemoryBlobStore } from './blob-store';
import { openProjectBlob, openProjectFile } from './project-io';

/** Damaged files fail with a ProjectFileError (a message for the user), never another exception. */

const PROJ = process.env.AG_PROJ;

function base(): Uint8Array {
  if (PROJ && existsSync(PROJ)) return new Uint8Array(readFileSync(PROJ));
  const sample = new Uint8Array(3000).map((_, i) => (i * 7) & 255);
  return writeProjectFile({
    project: createEmptyProject(),
    view: { mode: 'song' },
    samples: new Map([['a'.repeat(64), { ext: 'wav', bytes: sample }]]),
    appVersion: 't',
  });
}

async function outcome(bytes: Uint8Array): Promise<'ok' | 'user-error' | Error> {
  let result: 'ok' | 'user-error' | Error = 'ok';
  for (const run of [
    () => openProjectFile(bytes, { store: createMemoryBlobStore() }),
    () => openProjectBlob(new Blob([bytes as BlobPart]), { store: createMemoryBlobStore() }),
  ]) {
    try {
      await run();
    } catch (e) {
      if (!(e instanceof ProjectFileError && e.message.length > 10)) return e as Error;
      result = 'user-error';
    }
  }
  return result;
}

describe('damaged project files', () => {
  it('truncated at any length: a clear error', async () => {
    const bytes = base();
    const bad: string[] = [];
    const cuts = new Set<number>([0, 1, 3, 21, 22, 30]);
    for (let i = 1; i < 60; i++) cuts.add(Math.floor((bytes.length * i) / 60));
    for (let n = bytes.length - 30; n < bytes.length; n++) cuts.add(n);
    for (const n of cuts) {
      const r = await outcome(bytes.subarray(0, n));
      if (r !== 'user-error') bad.push(`${n}: ${r instanceof Error ? `${r.name}: ${r.message}` : r}`);
    }
    expect(bad).toEqual([]);
  });

  it('random byte flips never throw anything but a ProjectFileError', async () => {
    const bytes = base();
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const bad: string[] = [];
    for (let k = 0; k < 150; k++) {
      const copy = bytes.slice();
      const flips = 1 + Math.floor(rnd() * 8);
      for (let j = 0; j < flips; j++) copy[Math.floor(rnd() * copy.length)]! ^= 1 << Math.floor(rnd() * 8);
      const r = await outcome(copy);
      if (r instanceof Error) bad.push(`${k}: ${r.name}: ${r.message}`);
    }
    expect(bad).toEqual([]);
  });

  it('empty and non-zip inputs', async () => {
    for (const b of [new Uint8Array(0), new TextEncoder().encode('{"hello":1}'), new Uint8Array(5000).fill(0x50)]) {
      expect(await outcome(b)).toBe('user-error');
    }
  });

  it('a valid zip whose project.json has random wrong values: repaired to a consistent project, or a clear error', () => {
    const project = readProjectFile(base()).project;
    let seed = 99;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const junk = [null, 'x', -1, 1e9, NaN, [], {}, true, 0];
    const bad: string[] = [];
    for (let k = 0; k < 120; k++) {
      const doc = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
      for (let m = 0; m < 1 + Math.floor(rnd() * 4); m++) {
        let node: Record<string, unknown> = doc;
        for (let depth = 0; depth < 12; depth++) {
          const keys = Object.keys(node);
          if (keys.length === 0) break;
          const key = keys[Math.floor(rnd() * keys.length)]!;
          const child = node[key];
          if (typeof child === 'object' && child !== null && rnd() < 0.8) {
            node = child as Record<string, unknown>;
            continue;
          }
          if (rnd() < 0.25) delete node[key];
          else node[key] = junk[Math.floor(rnd() * junk.length)];
          break;
        }
      }
      const file = writeProjectFile({ project: doc as never, view: null, samples: new Map(), appVersion: 't' });
      try {
        const out = readProjectFile(file).project;
        const v = projectViolations(out);
        if (v.length) bad.push(`${k}: ${v.slice(0, 2).join('; ')}`);
      } catch (e) {
        if (!(e instanceof ProjectFileError)) bad.push(`${k}: ${(e as Error).name}: ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
