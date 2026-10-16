import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { History } from '@core/history/history';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project, SampleRef } from '@core/model/types';
import { createMemoryBlobStore, createSampleStore, type BlobGuard } from '../persistence/blob-store';
import { markBusy, whileBusy } from './busy';
import { memoryKv, tabKey } from './kv';
import { startTabRefs } from './tab-refs';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const A = hex(1);
const B = hex(2);
const C = hex(3);
const ref = (id: string, hash: string): SampleRef => ({ id: id as SampleRef['id'], name: id, source: { kind: 'embedded', hash, ext: 'wav' } });

beforeEach(() => {
  setIdSource(seededBytes(5));
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function tabSetup() {
  let doc: Project = { ...createEmptyProject({ now: new Date(0) }), samples: { s1: ref('s1', A) } as Project['samples'] };
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  const kv = memoryKv();
  const listeners = new Set<() => void>();
  let playing = false;
  history.onChange(() => listeners.forEach((fn) => fn()));
  const refs = startTabRefs({
    id: 'tab1',
    kv,
    project: () => doc,
    history,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    isPlaying: () => playing,
  });
  return { history, kv, refs, setPlaying: (v: boolean) => (playing = v), poke: () => listeners.forEach((fn) => fn()) };
}

describe('startTabRefs', () => {
  it('publishes what the project uses at startup', async () => {
    const t = tabSetup();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.kv.data.get(tabKey('tab1'))).toMatchObject({ v: 1, id: 'tab1', hashes: [A], playing: false, busy: false });
    t.refs.stop();
  });

  it('keeps a deleted sample published while Undo can bring it back', async () => {
    const t = tabSetup();
    t.history.transact('Delete', (d) => void delete d.samples['s1' as SampleRef['id']]);
    await vi.advanceTimersByTimeAsync(1100);
    expect((t.kv.data.get(tabKey('tab1')) as { hashes: string[] }).hashes).toEqual([A]);
    t.refs.stop();
  });

  it('publishes a change shortly after it, in one write for a burst of edits', async () => {
    const t = tabSetup();
    await vi.advanceTimersByTimeAsync(0);
    const set = vi.spyOn(t.kv, 'set');
    t.history.transact('Add', (d) => void (d.samples['s2' as SampleRef['id']] = ref('s2', B) as never));
    t.history.transact('Add', (d) => void (d.samples['s3' as SampleRef['id']] = ref('s3', C) as never));
    await vi.advanceTimersByTimeAsync(1100);
    expect(set).toHaveBeenCalledTimes(1);
    expect((t.kv.data.get(tabKey('tab1')) as { hashes: string[] }).hashes).toEqual([A, B, C]);
    t.refs.stop();
  });

  it('beats: the record’s time moves on without any change', async () => {
    const t = tabSetup();
    await vi.advanceTimersByTimeAsync(0);
    const first = (t.kv.data.get(tabKey('tab1')) as { heartbeat: number }).heartbeat;
    await vi.advanceTimersByTimeAsync(31_000);
    expect((t.kv.data.get(tabKey('tab1')) as { heartbeat: number }).heartbeat).toBeGreaterThan(first);
    t.refs.stop();
  });

  it('publishes playing, and busy with the audio of a running export pinned', async () => {
    const t = tabSetup();
    t.setPlaying(true);
    const done = markBusy({ hashes: [C] });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.kv.data.get(tabKey('tab1'))).toMatchObject({ playing: true, busy: true, hashes: [A, C] });
    done();
    done(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(t.kv.data.get(tabKey('tab1'))).toMatchObject({ busy: false, hashes: [A] });
    t.refs.stop();
  });

  it('whileBusy pins a project’s audio for the length of the work, even when it throws', async () => {
    const t = tabSetup();
    const p: Project = { ...createEmptyProject({ now: new Date(0) }), samples: { x: ref('x', B) } as Project['samples'] };
    await expect(
      whileBusy(
        async () => {
          expect(t.refs.hashes().has(B)).toBe(true);
          throw new Error('export failed');
        },
        { project: p },
      ),
    ).rejects.toThrow('export failed');
    expect(t.refs.hashes().has(B)).toBe(false);
    t.refs.stop();
  });

  it('stops publishing after stop(), and leaves the record behind', async () => {
    const t = tabSetup();
    await vi.advanceTimersByTimeAsync(0);
    t.refs.stop();
    const set = vi.spyOn(t.kv, 'set');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(set).not.toHaveBeenCalled();
    expect(t.kv.data.has(tabKey('tab1'))).toBe(true);
  });
});

describe('the sample store with a guard', () => {
  function guarded() {
    const calls: string[] = [];
    let holding = 0;
    const guard: BlobGuard = {
      async hold(fn) {
        calls.push('hold');
        holding++;
        try {
          return await fn();
        } finally {
          holding--;
        }
      },
      async touch(hash) {
        calls.push(`touch ${hash.slice(-1)} holding=${holding}`);
      },
    };
    const primary = createMemoryBlobStore();
    return { calls, store: createSampleStore(primary, { guard }), primary };
  }
  const bytes = Uint8Array.from([1, 2, 3]);

  it('marks a blob in use, inside the hold, when it is written (also when it was already stored)', async () => {
    const g = guarded();
    await g.store.putBlob(A, 'wav', bytes);
    await g.store.putBlob(A, 'wav', bytes);
    expect(g.calls).toEqual(['hold', 'touch 1 holding=1', 'hold', 'touch 1 holding=1']);
  });

  it('marks it when a lookup finds it, inside the hold, and not when it is missing', async () => {
    const g = guarded();
    await g.primary.putBlob(A, 'wav', bytes);
    expect(await g.store.hasBlob(B)).toBe(false);
    expect(g.calls).toEqual(['hold']);
    expect(await g.store.hasBlob(A)).toBe(true);
    expect(g.calls).toEqual(['hold', 'hold', 'touch 1 holding=1']);
  });

  it('marks it when it is read', async () => {
    const g = guarded();
    await g.primary.putBlob(A, 'wav', bytes);
    expect((await g.store.getBlob(A))?.bytes).toEqual(bytes);
    expect(await g.store.getBlob(B)).toBeNull();
    expect(g.calls).toEqual(['hold', 'touch 1 holding=1']);
  });

  it('does nothing extra without a guard', async () => {
    const store = createSampleStore(createMemoryBlobStore());
    await store.putBlob(A, 'wav', bytes);
    expect(await store.hasBlob(A)).toBe(true);
    expect((await store.getBlob(A))?.ext).toBe('wav');
  });
});
