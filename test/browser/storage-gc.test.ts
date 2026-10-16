import { afterEach, describe, expect, it } from 'vitest';
import { writeProjectFile } from '@core/io/project-file';
import type { SampleRef } from '@core/model/types';
import { BLOBS_LOCK, createSharedHold, sessionLockName } from '@platform/locks';
import type { AutosaveMeta } from '@platform/opfs';
import { loadAutosave } from '@app/persistence/autosave';
import { collectGarbage } from '@app/storage/collector';
import { createBlobGuard } from '@app/storage/guard';
import { cleanupGc, env, openTab, projectOf, put, ref, stored, supported, until } from '../helpers/gc-world';

afterEach(cleanupGc);

describe.skipIf(!supported)('clean-up of unused audio in the browser', () => {
  it('tab B’s referenced blob is never deleted by tab A’s collection', async () => {
    const e = await env();
    const x = await put(e, 1);
    const y = await put(e, 2);
    const z = await put(e, 3);
    const a = await openTab(e, 'a', projectOf(x.ref));
    const b = await openTab(e, 'b', projectOf(y.ref));
    e.skew.days = 30; // everything is old
    const result = await collectGarbage(e.deps(a));
    expect(result).toMatchObject({ status: 'done', removed: 1 });
    expect(await stored(e)).toEqual([x.hash, y.hash].sort());
    expect(await e.store.hasBlob(z.hash)).toBe(false);
    a.close();
    b.close();
  });

  it('a sample deleted in tab A but still in its undo history survives, and goes after the history is cleared', async () => {
    const e = await env();
    const x = await put(e, 1);
    const a = await openTab(e, 'a', projectOf(x.ref));
    a.history.transact('Delete sample', (d) => void delete d.samples['s1' as SampleRef['id']]);
    await a.refs.publishNow();
    e.skew.days = 30;
    await collectGarbage(e.deps(a));
    expect(await stored(e)).toEqual([x.hash]);
    // Undo brings the sample back, and it still plays.
    a.history.undo();
    expect(Object.keys(a.doc().samples)).toEqual(['s1']);
    expect(await e.store.getBlob(x.hash)).not.toBeNull();
    // Delete it again, then start a new project: nothing can bring it back any more.
    a.history.redo();
    a.history.load(projectOf());
    await a.refs.publishNow();
    // The mark from the read above counts as "last used": wait out another grace period.
    e.skew.days = 40;
    await collectGarbage(e.deps(a));
    expect(await stored(e)).toEqual([]);
    a.close();
  });

  it('after the grace period (fake clock), truly unreferenced blobs are removed, not before', async () => {
    const e = await env();
    const used = await put(e, 1);
    await put(e, 2);
    await put(e, 3);
    const tab = await openTab(e, 'a', projectOf(used.ref));
    e.skew.days = 3;
    expect(await collectGarbage(e.deps(tab))).toMatchObject({ status: 'done', removed: 0, waiting: 2 });
    expect(await stored(e)).toHaveLength(3);
    e.skew.days = 6.9;
    expect(await collectGarbage(e.deps(tab))).toMatchObject({ removed: 0 });
    e.skew.days = 7.1;
    expect(await collectGarbage(e.deps(tab))).toMatchObject({ status: 'done', removed: 2 });
    expect(await stored(e)).toEqual([used.hash]);
    tab.close();
  });

  it('ignores the record of a tab whose lock is gone (the tab was closed)', async () => {
    const e = await env();
    const x = await put(e, 1);
    const y = await put(e, 2);
    const a = await openTab(e, 'a', projectOf(x.ref));
    const b = await openTab(e, 'b', projectOf(y.ref));
    b.close();
    await b.closed;
    e.skew.days = 3; // B was alive 3 days ago in this fake time: its audio is kept, but no longer "in use"
    expect(await collectGarbage(e.deps(a))).toMatchObject({ removed: 0 });
    expect((await e.kv.keys((k) => k.startsWith('gc:tab:'))).map((k) => k.slice('gc:tab:'.length))).toEqual([a.id]);
    e.skew.days = 11;
    // A's heartbeat is old too, but A's lock is held and its project uses x.
    expect(await collectGarbage(e.deps(a))).toMatchObject({ removed: 1 });
    expect(await stored(e)).toEqual([x.hash]);
    a.close();
  });

  it('does nothing while a tab holds its lock but has published nothing', async () => {
    const e = await env();
    await put(e, 1);
    const newcomer = document.createElement('iframe');
    document.body.append(newcomer);
    await new Promise<void>((resolve) =>
      newcomer.contentWindow!.navigator.locks.request(sessionLockName(`${e.prefix}newcomer`), () => {
        resolve();
        return new Promise<void>(() => {});
      }),
    );
    e.skew.days = 30;
    expect(await collectGarbage(e.deps())).toEqual({ status: 'skipped', reason: 'tab-starting' });
    expect(await stored(e)).toHaveLength(1);
    newcomer.remove();
  });

  it('runs one collection at a time across tabs (the ag-gc lock)', async () => {
    const e = await env();
    await put(e, 1);
    e.skew.days = 30;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const inside = new Promise<void>((resolve) => void navigator.locks.request('ag-gc', () => (resolve(), held)));
    await inside;
    expect(await collectGarbage(e.deps())).toEqual({ status: 'skipped', reason: 'locked' });
    release();
    await until(async () => (await collectGarbage(e.deps())).status === 'done');
  });

  it('a writer holding the store waits out the delete batch, and its mark keeps the blob', async () => {
    const e = await env();
    const x = await put(e, 1);
    e.skew.days = 30;
    const hold = createSharedHold(BLOBS_LOCK);
    const guard = createBlobGuard({ kv: e.kv, now: e.now, hold });
    let touched = false;
    let release!: () => void;
    const go = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((resolve) => {
      void guard.hold(async () => {
        resolve();
        await go;
        await guard.touch(x.hash); // the writer looks at the blob, then marks it, inside the hold
        touched = true;
      });
    });
    await entered;
    const collecting = collectGarbage(e.deps());
    await new Promise((r) => setTimeout(r, 300));
    // The batch is waiting for the writer: nothing is deleted yet.
    expect(await stored(e)).toEqual([x.hash]);
    release();
    const result = await collecting;
    expect(touched).toBe(true);
    expect(result).toMatchObject({ status: 'done', removed: 0 });
    expect(await stored(e)).toEqual([x.hash]);
  });
});

describe.skipIf(!supported)('recovery after a collection', () => {
  it('recovers an autosave after a collection and every sample is still there', async () => {
    const e = await env();
    const samples = [await put(e, 1), await put(e, 2), await put(e, 3, 5000)];
    const orphan = await put(e, 4);
    // A tab edits a project that uses three samples, autosaves (thin: no sample bytes), then crashes.
    const crashed = await openTab(e, 'crashed', projectOf(...samples.map((s) => s.ref)));
    const project = crashed.doc();
    const meta: AutosaveMeta = {
      sessionId: crashed.id.replace(/[^A-Za-z0-9_-]/g, '-'),
      projectId: project.projectId,
      title: 'Song',
      savedAt: new Date().toISOString(),
      clean: false,
      slot: 'a',
    };
    await e.storage.writeAutosave(
      meta.sessionId,
      'a',
      writeProjectFile({ project, view: { mode: 'song' }, samples: new Map(), appVersion: '0', now: new Date(0) }),
      meta,
    );
    crashed.close();
    await crashed.closed;
    // Much later, another tab collects. Nothing but the autosave refers to the three samples.
    const other = await openTab(e, 'other', projectOf());
    e.skew.days = 60;
    expect(await collectGarbage(e.deps(other))).toMatchObject({ status: 'done', removed: 1 });
    expect(await stored(e)).toEqual(samples.map((s) => s.hash).sort());
    expect(await e.store.hasBlob(orphan.hash)).toBe(false);
    // Recovery opens the autosave: every sample is present, none is reported missing.
    const loaded = await loadAutosave(meta.sessionId, { storage: e.storage, store: e.store });
    expect(loaded).not.toBeNull();
    expect(loaded!.missingSamples).toEqual([]);
    for (const s of samples) expect((await e.store.getBlob(s.hash))?.bytes.byteLength).toBe(s.size);
    other.close();
  });
});

describe.skipIf(!supported)('collection time', () => {
  it('collects 1,000 blobs (half in use) and reports how long it takes', async () => {
    const e = await env();
    const hashes: string[] = [];
    for (let i = 0; i < 1000; i++) hashes.push((await put(e, i + 1, 600)).hash);
    const tab = await openTab(e, 'big', projectOf(...hashes.slice(0, 500).map((h, i) => ref(`s${i}`, h))));
    e.skew.days = 30;
    const s0 = performance.now();
    await e.storage.blobStats();
    const statMs = performance.now() - s0;
    const t0 = performance.now();
    const result = await collectGarbage(e.deps(tab), { batch: 50 });
    const ms = performance.now() - t0;
    console.log(`[gc timing] listing 1000 blobs with size and age: ${statMs.toFixed(0)} ms; whole collection (500 removed): ${ms.toFixed(0)} ms`);
    expect(result).toMatchObject({ status: 'done', removed: 500 });
    expect(await e.storage.listBlobs()).toHaveLength(500);
    expect(ms, `listing ${statMs.toFixed(0)} ms, collection ${ms.toFixed(0)} ms`).toBeLessThan(60_000);
    tab.close();
  });
});

