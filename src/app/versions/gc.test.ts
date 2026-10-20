import { beforeEach, describe, expect, it } from 'vitest';
import { GRACE_MS, type BlobStat } from '@core/gc/plan';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project, SampleRef } from '@core/model/types';
import { emptySong } from '@core/versions/test-songs';
import type { withExclusiveLock } from '@platform/locks';
import { collectGarbage, previewCollection, type CollectorDeps } from '../storage/collector';
import { memoryKv } from '../storage/kv';
import { measureUsage } from '../storage/usage';
import { memoryVersionFiles } from './memory';
import { VersionStore } from './store';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const hex = (n: number) => n.toString(16).padStart(64, '0');
const A = hex(1);
const B = hex(2);

beforeEach(() => setIdSource(seededBytes(21)));

const withSamples = (project: Project, ...hashes: string[]): Project => ({
  ...project,
  samples: Object.fromEntries(
    hashes.map((hash) => {
      const ref: SampleRef = { id: `smp_${hash.slice(-4)}` as SampleRef['id'], name: 'x', source: { kind: 'embedded', hash, ext: 'wav' } };
      return [ref.id, ref];
    }),
  ),
});

/** The storage clean-up on fakes (this tab alive and using `inUse`), and a version store on the same key-value store. */
function world(blobHashes: string[], inUse: string[] = []) {
  const kv = memoryKv();
  const clock = { now: NOW };
  const blobs = new Map<string, BlobStat>(blobHashes.map((hash) => [hash, { hash, ext: 'wav', size: 1_000_000, modifiedAt: NOW - 90 * DAY }]));
  const deleted: string[] = [];
  const exclusive: typeof withExclusiveLock = async (_name, fn) => ({ ran: true, value: await fn() });
  const self = { v: 1 as const, id: 'me', hashes: inUse, heartbeat: NOW, playing: false, busy: false };
  const deps: CollectorDeps = {
    kv,
    blobs: {
      blobStats: async () => [...blobs.values()],
      deleteBlob: async (hash) => {
        deleted.push(hash);
        blobs.delete(hash);
      },
    },
    autosaves: { files: async () => [] },
    supported: true,
    heldTabs: async () => new Set(['me']),
    exclusive,
    self: { id: 'me', record: () => self },
    now: () => clock.now,
  };
  const store = new VersionStore({ kv, files: memoryVersionFiles(), appVersion: 'test', now: () => clock.now });
  return { kv, clock, blobs, deleted, deps, store };
}

describe('storage clean-up and versions', () => {
  it('keeps a sample that only an old version uses', async () => {
    const w = world([A, B]);
    await w.store.create({ project: withSamples(emptySong(), A), view: null, reason: 'timer' });
    const result = await collectGarbage(w.deps);
    expect(result).toMatchObject({ status: 'done', removed: 1 });
    expect(w.deleted).toEqual([B]);
    expect([...w.blobs.keys()]).toEqual([A]);
  });

  it('keeps it however long ago it was written or last seen', async () => {
    const w = world([A]);
    await w.store.create({ project: withSamples(emptySong(), A), view: null, reason: 'timer' });
    for (let month = 0; month < 3; month++) {
      w.clock.now += 40 * DAY;
      await collectGarbage(w.deps);
    }
    expect(w.deleted).toEqual([]);
  });

  it('frees the sample after the version is deleted, once the usual grace period has passed', async () => {
    const w = world([A]);
    const record = (await w.store.create({ project: withSamples(emptySong(), A), view: null, reason: 'timer' }))!;
    await collectGarbage(w.deps); // sees A in use now
    await w.store.remove(record);

    // Deleted just now: nothing refers to A any more, but it was in use a moment ago, so it waits.
    w.clock.now += 2 * DAY;
    const preview = await previewCollection(w.deps);
    expect(preview.plan.remove).toEqual([]);
    expect(preview.plan.waiting.map((b) => b.hash)).toEqual([A]);
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([]);

    w.clock.now += GRACE_MS;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([A]);
  });

  it('keeps the sample while any one of several versions still uses it', async () => {
    const w = world([A]);
    const first = (await w.store.create({ project: withSamples(emptySong('One'), A), view: null, reason: 'timer' }))!;
    const second = (await w.store.create({ project: withSamples(emptySong('Two'), A), view: null, reason: 'timer' }))!;
    await collectGarbage(w.deps);
    await w.store.remove(first);
    w.clock.now += 30 * DAY;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([]);
    await w.store.remove(second);
    await collectGarbage(w.deps); // A is seen unused now: the grace starts
    w.clock.now += GRACE_MS + DAY;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([A]);
  });

  it('counts a version’s audio as project audio, not as unused, in the usage numbers', async () => {
    const w = world([A, B]);
    await w.store.create({ project: withSamples(emptySong(), A), view: null, reason: 'timer' });
    const usage = await measureUsage(w.deps);
    expect(usage.projectAudio).toEqual({ files: 1, bytes: 1_000_000 });
    expect(usage.unused.removable.files + usage.unused.waiting.files).toBe(1);
  });
});
