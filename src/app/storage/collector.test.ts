import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRACE_MS, type BlobStat } from '@core/gc/plan';
import type { TabRecord } from '@core/gc/tabs';
import { writeProjectFile } from '@core/io/project-file';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { SampleRef } from '@core/model/types';
import type { withExclusiveLock } from '@platform/locks';
import type { AutosaveFile } from '@platform/opfs';
import { collectGarbage, previewCollection, type CollectorDeps } from './collector';
import { createBlobGuard } from './guard';
import { LAST_RUN_KEY, memoryKv, seenKey, tabKey, type GcKv } from './kv';
import { measureUsage } from './usage';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const A = hex(1);
const B = hex(2);
const C = hex(3);
const D = hex(4);
const E = hex(5);
const F = hex(6);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-16T12:00:00Z');

beforeEach(() => setIdSource(seededBytes(3)));

const sampleRef = (hash: string): SampleRef => ({ id: `s${hash.slice(-2)}` as SampleRef['id'], name: 'x', source: { kind: 'embedded', hash, ext: 'wav' } });

function autosaveOf(...hashes: string[]): AutosaveFile {
  const p = createEmptyProject({ now: new Date(0) });
  const project = { ...p, samples: Object.fromEntries(hashes.map((h) => [sampleRef(h).id, sampleRef(h)])) };
  const data = writeProjectFile({ project, view: null, samples: new Map(), appVersion: '0', now: new Date(0) });
  return { sessionId: 'old', slot: 'a', size: data.byteLength, read: async () => data };
}

interface World {
  deps: CollectorDeps;
  kv: ReturnType<typeof memoryKv>;
  blobs: Map<string, BlobStat>;
  deleted: string[];
  held: Set<string>;
  autosaves: AutosaveFile[];
  clock: { now: number };
  /** Runs before the body of a lock request (tests use it to play the part of another tab). */
  beforeLock: Array<(name: string) => Promise<void> | void>;
  log: string[];
}

function world(opts: { blobs?: BlobStat[]; self?: TabRecord | null } = {}): World {
  const kv = memoryKv();
  const blobs = new Map((opts.blobs ?? []).map((b) => [b.hash, b]));
  const deleted: string[] = [];
  const held = new Set<string>();
  const autosaves: AutosaveFile[] = [];
  const clock = { now: NOW };
  const beforeLock: World['beforeLock'] = [];
  const log: string[] = [];
  // One holder at a time per lock name; `ifAvailable` gives up instead of waiting.
  const locked = new Set<string>();
  const exclusive: typeof withExclusiveLock = async (name, fn, o = {}) => {
    if (locked.has(name)) {
      if (o.ifAvailable) return { ran: false };
      throw new Error(`lock ${name} is taken (the test fake does not queue)`);
    }
    locked.add(name);
    try {
      for (const hook of beforeLock) await hook(name);
      return { ran: true, value: await fn() };
    } finally {
      locked.delete(name);
    }
  };
  const self = opts.self === undefined ? ({ v: 1, id: 'me', hashes: [], heartbeat: NOW, playing: false, busy: false } satisfies TabRecord) : opts.self;
  held.add('me');
  const deps: CollectorDeps = {
    kv,
    blobs: {
      blobStats: async () => [...blobs.values()],
      deleteBlob: async (h) => {
        deleted.push(h);
        blobs.delete(h);
      },
    },
    autosaves: { files: async () => autosaves },
    supported: true,
    heldTabs: async () => new Set(held),
    exclusive,
    ...(self ? { self: { id: self.id, record: () => self } } : {}),
    now: () => clock.now,
    log: (m) => log.push(m),
  };
  return { deps, kv, blobs, deleted, held, autosaves, clock, beforeLock, log };
}

const old = (hash: string, ageDays = 30, size = 1_000_000): BlobStat => ({ hash, ext: 'wav', size, modifiedAt: NOW - ageDays * DAY });
const tab = (id: string, hashes: string[], over: Partial<TabRecord> = {}): TabRecord => ({ v: 1, id, hashes, heartbeat: NOW, playing: false, busy: false, ...over });
const publish = (w: World, r: TabRecord, live = true) => {
  w.kv.data.set(tabKey(r.id), r);
  if (live) w.held.add(r.id);
};

describe('collectGarbage: what counts as in use', () => {
  it('removes old unreferenced audio and nothing else', async () => {
    const w = world({ blobs: [old(A), old(B), old(C)] });
    publish(w, tab('t1', [B]));
    const r = await collectGarbage(w.deps);
    expect(r).toMatchObject({ status: 'done', removed: 2, bytes: 2_000_000 });
    expect(w.deleted.sort()).toEqual([A, C]);
    expect([...w.blobs.keys()]).toEqual([B]);
  });

  it('keeps everything an open tab uses (its project, its undo history, its running operations)', async () => {
    // A tab publishes all three as one set, so any hash in it is safe.
    const w = world({ blobs: [old(A), old(B), old(C), old(D)] });
    publish(w, tab('t1', [A, B]));
    publish(w, tab('t2', [C]));
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([D]);
  });

  it('keeps this tab’s own audio, read from memory rather than from what it last published', async () => {
    const w = world({ blobs: [old(A), old(B)], self: tab('me', [A]) });
    w.kv.data.set(tabKey('me'), tab('me', [])); // stale copy in storage
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B]);
  });

  it('keeps audio an autosave mentions', async () => {
    const w = world({ blobs: [old(A), old(B), old(C)] });
    w.autosaves.push(autosaveOf(A, C));
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B]);
  });

  it('keeps the DJ library’s songs and ignores their cached analyses', async () => {
    const w = world({ blobs: [old(A), old(B), old(C)] });
    w.kv.data.set('dj-library', [{ key: A, title: 't', label: 'l', ref: sampleRef(A) }]);
    w.kv.data.set(`dj-analysis:v3:${B}`, { hash: B, version: 3 }); // an analysis is not a use
    w.kv.data.set(`dj-analysis:v3:${A}`, { hash: A, version: 3 });
    await collectGarbage(w.deps);
    expect(w.deleted.sort()).toEqual([B, C]);
    // The analysis of a removed song goes with it; a kept song keeps its analysis.
    expect(w.kv.data.has(`dj-analysis:v3:${B}`)).toBe(false);
    expect(w.kv.data.has(`dj-analysis:v3:${A}`)).toBe(true);
  });

  it('keeps audio mentioned by any other stored value (presets, recent files…)', async () => {
    const w = world({ blobs: [old(A), old(B)] });
    w.kv.data.set('user-presets:v1', [{ name: 'p', state: { sample: sampleRef(A) } }]);
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B]);
  });

  it('does not count recent files, which hold only handles', async () => {
    const w = world({ blobs: [old(A)] });
    w.kv.data.set('recent-files', [{ key: 'f1', name: 'Song.agproj', usedAt: 'x' }]);
    w.kv.data.set('file-handle:f1', {}); // a FileSystemFileHandle clones to an opaque object
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([A]);
  });
});

describe('collectGarbage: the grace period', () => {
  it('keeps unreferenced audio written less than 7 days ago', async () => {
    const w = world({ blobs: [old(A, 6.9), old(B, 7.1)] });
    const r = await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B]);
    expect(r).toMatchObject({ status: 'done', removed: 1, waiting: 1 });
  });

  it('removes it once the (fake) clock passes the grace period', async () => {
    const w = world({ blobs: [old(A, 6.9)] });
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([]);
    w.clock.now += 0.2 * DAY;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([A]);
  });

  it('counts the last time audio was in use: referenced today, unreferenced tomorrow, kept for a week', async () => {
    const w = world({ blobs: [old(A, 90)] });
    const t = tab('t1', [A]);
    publish(w, t);
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([]);
    expect(w.kv.data.get(seenKey(A))).toBe(NOW);
    // The project is closed (the tab's lock goes with it).
    w.held.delete('t1');
    w.kv.data.delete(tabKey('t1'));
    w.clock.now += 6 * DAY;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([]);
    w.clock.now += 1.1 * DAY;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([A]);
  });

  it('keeps audio a guard marked in use (written or looked up) however old the file is', async () => {
    const w = world({ blobs: [old(A, 90), old(B, 90)] });
    const guard = createBlobGuard({ kv: w.kv, hold: (fn) => fn(), now: () => NOW });
    await guard.touch(A);
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B]);
  });
});

describe('collectGarbage: other tabs', () => {
  it('ignores the record of a tab whose lock is gone, remembers when it was last alive, and discards it', async () => {
    const w = world({ blobs: [old(A, 90), old(B, 90)] });
    publish(w, tab('dead', [A], { heartbeat: NOW - 2 * DAY }), false);
    await collectGarbage(w.deps);
    // Not trusted as a reference, but its audio counts as seen two days ago: kept.
    expect(w.deleted).toEqual([B]);
    expect(w.kv.data.has(tabKey('dead'))).toBe(false);
    expect(w.kv.data.get(seenKey(A))).toBe(NOW - 2 * DAY);
    // A week after the tab was last alive it may go.
    w.clock.now += 5.1 * DAY;
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B, A]);
  });

  it('removes the audio of a tab that died long ago', async () => {
    const w = world({ blobs: [old(A, 90)] });
    publish(w, tab('dead', [A], { heartbeat: NOW - 30 * DAY }), false);
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([A]);
  });

  it('does nothing while a tab holds its lock but has published nothing (it is starting up)', async () => {
    const w = world({ blobs: [old(A)] });
    w.held.add('newcomer');
    expect(await collectGarbage(w.deps)).toEqual({ status: 'skipped', reason: 'tab-starting' });
    expect(w.deleted).toEqual([]);
  });

  it('does nothing while a tab is exporting; the automatic run also waits for playback', async () => {
    const w = world({ blobs: [old(A)] });
    publish(w, tab('t1', [], { busy: true }));
    expect(await collectGarbage(w.deps)).toEqual({ status: 'skipped', reason: 'busy' });
    publish(w, tab('t1', [], { playing: true }));
    expect(await collectGarbage(w.deps, { idle: true })).toEqual({ status: 'skipped', reason: 'playing' });
    expect(w.deleted).toEqual([]);
    expect(await collectGarbage(w.deps)).toMatchObject({ status: 'done', removed: 1 });
  });

  it('runs one clean-up at a time', async () => {
    const w = world({ blobs: [old(A)] });
    let inner: Awaited<ReturnType<typeof collectGarbage>> | undefined;
    w.beforeLock.push(async (name) => {
      if (name === 'ag-gc' && !inner) inner = await collectGarbage(w.deps);
    });
    await collectGarbage(w.deps);
    expect(inner).toEqual({ status: 'skipped', reason: 'locked' });
  });

  it('does nothing without Web Locks', async () => {
    const w = world({ blobs: [old(A)] });
    expect(await collectGarbage({ ...w.deps, supported: false })).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(w.deleted).toEqual([]);
  });
});

describe('collectGarbage: safety under change and failure', () => {
  it('re-checks each batch: audio another tab started using since the plan is not deleted', async () => {
    const w = world({ blobs: [old(A), old(B), old(C)] });
    // Between the plan and the first delete, a writer marks B in use (it just imported it again).
    w.beforeLock.push(async (name) => {
      if (name === 'ag-blobs') await w.kv.set([[seenKey(B), NOW]]);
    });
    await collectGarbage(w.deps);
    expect(w.deleted.sort()).toEqual([A, C]);
    expect(w.blobs.has(B)).toBe(true);
  });

  it('re-checks each batch: a tab that opened the project in the meantime keeps its audio', async () => {
    const w = world({ blobs: [old(A), old(B)] });
    w.beforeLock.push(async (name) => {
      if (name === 'ag-blobs') publish(w, tab('t9', [A]));
    });
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([B]);
  });

  it('stops when a tab appears that has published nothing', async () => {
    const w = world({ blobs: [old(A), old(B)] });
    w.beforeLock.push(async (name) => {
      if (name === 'ag-blobs') w.held.add('newcomer');
    });
    await collectGarbage(w.deps, { batch: 1 });
    expect(w.deleted).toEqual([]);
  });

  it('deletes nothing when a source of references cannot be read', async () => {
    const w = world({ blobs: [old(A)] });
    const broken: GcKv = { ...w.kv, entries: async () => Promise.reject(new Error('IndexedDB is closed')) };
    const r = await collectGarbage({ ...w.deps, kv: broken });
    expect(r).toMatchObject({ status: 'skipped', reason: 'error' });
    expect(w.deleted).toEqual([]);
  });

  it('deletes nothing when the autosaves cannot be listed', async () => {
    const w = world({ blobs: [old(A)] });
    const r = await collectGarbage({ ...w.deps, autosaves: { files: async () => Promise.reject(new Error('OPFS')) } });
    expect(r).toMatchObject({ status: 'skipped', reason: 'error' });
    expect(w.deleted).toEqual([]);
  });

  it('works in small batches and reports progress; shouldStop ends it between batches', async () => {
    const w = world({ blobs: [A, B, C, D, E].map((h) => old(h)) });
    const progress: Array<[number, number]> = [];
    let stop = false;
    const r = await collectGarbage(w.deps, {
      batch: 2,
      onProgress: (d, t) => {
        progress.push([d, t]);
        if (d >= 2) stop = true;
      },
      shouldStop: () => stop,
    });
    expect(progress).toEqual([[2, 5]]);
    expect(r).toMatchObject({ status: 'skipped', reason: 'stopped', removed: 2 });
    expect(w.deleted).toHaveLength(2);
  });

  it('keeps going when one delete fails', async () => {
    const w = world({ blobs: [old(A), old(B)] });
    const real = w.deps.blobs.deleteBlob;
    const deps: CollectorDeps = {
      ...w.deps,
      blobs: { ...w.deps.blobs, deleteBlob: async (h) => (h === A ? Promise.reject(new Error('busy')) : real(h)) },
    };
    const r = await collectGarbage(deps);
    expect(r).toMatchObject({ status: 'done', removed: 1, failed: 1 });
    expect(w.deleted).toEqual([B]);
  });

  it('a dry run deletes nothing, logs what it would remove, and records that it was a dry run', async () => {
    const w = world({ blobs: [old(A), old(B)] });
    publish(w, tab('t1', [B]));
    const r = await collectGarbage(w.deps, { dryRun: true });
    expect(r).toMatchObject({ status: 'dry-run', removed: 1 });
    expect(w.deleted).toEqual([]);
    expect(w.log.join('\n')).toContain('would remove 1 unused audio files');
    expect(w.log.join('\n')).toContain(A.slice(0, 12));
    expect(w.kv.data.get(LAST_RUN_KEY)).toMatchObject({ dryRun: true, removed: 1 });
  });
});

describe('recovery after a collection', () => {
  it('keeps every sample of an autosave that has not been recovered yet', async () => {
    const w = world({ blobs: [A, B, C, D].map((h) => old(h, 120)) });
    // The tab that wrote it crashed: no lock, no live record. Its autosave is all that refers to the audio.
    w.autosaves.push(autosaveOf(A, B, C));
    publish(w, tab('crashed', [A, B, C], { heartbeat: NOW - 60 * DAY }), false);
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([D]);
    expect([...w.blobs.keys()].sort()).toEqual([A, B, C]);
  });
});

describe('previewCollection and measureUsage', () => {
  it('previews without changing anything', async () => {
    const w = world({ blobs: [old(A), old(B, 2)] });
    publish(w, tab('dead', [], {}), false);
    const before = new Map(w.kv.data);
    const p = await previewCollection(w.deps);
    expect(p.plan.remove.map((b) => b.hash)).toEqual([A]);
    expect(p.plan.waiting.map((b) => b.hash)).toEqual([B]);
    expect(w.kv.data).toEqual(before);
    expect(w.deleted).toEqual([]);
  });

  it('says why a run would not start', async () => {
    const w = world({ blobs: [old(A)] });
    w.held.add('newcomer');
    expect((await previewCollection(w.deps)).blocked).toBe('tab-starting');
  });

  it('adds up: project audio + DJ library + stretched copies + other = total', async () => {
    const w = world({ blobs: [old(A, 30, 5_000_000), old(B, 30, 3_000_000), old(C, 30, 2_000_000), old(D, 2, 1_000_000)] });
    publish(w, tab('t1', [A]));
    w.kv.data.set('dj-library', [{ ref: sampleRef(B) }]);
    w.autosaves.push(autosaveOf(A));
    const u = await measureUsage({ ...w.deps, derived: { usage: async () => ({ files: 3, bytes: 7_000_000 }) } });
    expect(u.projectAudio).toEqual({ files: 1, bytes: 5_000_000 });
    expect(u.djLibrary).toEqual({ files: 1, bytes: 3_000_000 });
    expect(u.stretched).toEqual({ files: 3, bytes: 7_000_000 });
    expect(u.other.unusedBytes).toBe(3_000_000);
    expect(u.other.autosaveBytes).toBe(w.autosaves[0]!.size);
    expect(u.total).toBe(u.projectAudio.bytes + u.djLibrary.bytes + u.stretched.bytes + u.other.bytes);
    expect(u.unused.removable).toEqual({ files: 1, bytes: 2_000_000 });
    expect(u.unused.waiting).toEqual({ files: 1, bytes: 1_000_000 });
  });
});

describe('guard', () => {
  it('writes a "seen" mark, and not again within a few minutes', async () => {
    const kv = memoryKv();
    const set = vi.spyOn(kv, 'set');
    let now = NOW;
    const g = createBlobGuard({ kv, hold: (fn) => fn(), now: () => now });
    await g.touch(A);
    await g.touch(A);
    now += 60_000;
    await g.touch(A);
    expect(set).toHaveBeenCalledTimes(1);
    now += 6 * 60_000;
    await g.touch(A);
    expect(set).toHaveBeenCalledTimes(2);
    expect(kv.data.get(seenKey(A))).toBe(now);
  });

  it('never fails the caller when the mark cannot be written', async () => {
    const kv: GcKv = { ...memoryKv(), set: async () => Promise.reject(new Error('quota')) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(createBlobGuard({ kv, hold: (fn) => fn() }).touch(A)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('constants', () => {
  it('the grace period is 7 days', () => expect(GRACE_MS).toBe(7 * DAY));
  it('an unused hash that nothing ever marked starts its grace period now', async () => {
    const w = world({ blobs: [{ hash: F, ext: 'wav', size: 10 }] });
    await collectGarbage(w.deps);
    expect(w.deleted).toEqual([]);
    expect(w.kv.data.get(seenKey(F))).toBe(NOW);
  });
});
