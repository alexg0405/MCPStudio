import { beforeEach, describe, expect, it } from 'vitest';
import { History } from '../history/history';
import { projectFileHashes, writeProjectFile } from '../io/project-file';
import { createEmptyProject } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import type { Project, SampleRef } from '../model/types';
import { GRACE_MS, SEEN_REFRESH_MS, planCollection, type BlobStat } from './plan';
import { collectHashes } from './refs';
import { classifyTabs, liveHashes, readiness, type TabRecord } from './tabs';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const A = hex(0xa);
const B = hex(0xb);
const C = hex(0xc);
const D = hex(0xd);
const DAY = 24 * 60 * 60 * 1000;

const ref = (id: string, hash: string): SampleRef => ({
  id: id as SampleRef['id'],
  name: id,
  source: { kind: 'embedded', hash, ext: 'wav' },
});

function projectWith(...refs: SampleRef[]): Project {
  const p = createEmptyProject({ now: new Date(0) });
  return { ...p, samples: Object.fromEntries(refs.map((r) => [r.id, r])) };
}

beforeEach(() => setIdSource(seededBytes(7)));

describe('collectHashes', () => {
  it('finds hashes in a project, wherever they are', () => {
    const p = projectWith(ref('s1', A), ref('s2', B));
    expect([...collectHashes(p)].sort()).toEqual([A, B]);
  });

  it('finds hashes in DJ mix and sound filter records', () => {
    const p = projectWith(ref('s1', A));
    const withRecords = {
      ...p,
      // A DJ mix keeps its songs' samples; a sound filter keeps the clips it replaced, each of which may
      // carry the sample it plays. Whatever the shape, a hash anywhere counts.
      dj: { songs: [{ sampleId: 's1', title: 'x', sample: ref('s3', C) }], options: {}, tweaks: {}, made: { channels: [], markers: [] } },
      channels: { c1: { kind: 'audioClip', filter: { preset: 'nightcore', originals: [{ id: 'k1', sample: ref('s4', D) }], pieces: [] } } },
    };
    expect([...collectHashes(withRecords)].sort()).toEqual([A, C, D]);
  });

  it('finds a hash inside a longer string, in a key, and in upper case, and ignores near misses', () => {
    const upper = hex(0xabc).toUpperCase();
    const found = collectHashes({
      note: `file ${A}.wav`,
      [B]: 1,
      upper,
      short: A.slice(1),
      long: 'x'.repeat(200),
      num: 5,
      nested: [[{ deep: C }]],
    });
    expect([...found].sort()).toEqual([A, B, C, hex(0xabc)].sort());
  });

  it('skips handles and class instances, and survives shared and repeated objects', () => {
    class Handle {
      hash = A;
    }
    const shared = Object.freeze({ h: B });
    const found = collectHashes({ handle: new Handle(), bytes: new Uint8Array(70), a: shared, b: shared, c: [shared, shared] });
    expect([...found]).toEqual([B]);
    // Asking again (the memoized path) gives the same answer.
    expect([...collectHashes({ x: shared })]).toEqual([B]);
  });
});

describe('undo and redo history', () => {
  function setup(p: Project) {
    let doc = p;
    const history = new History({ get: () => doc, set: (x) => void (doc = x) });
    return { history, doc: () => doc };
  }

  it('keeps a deleted sample referenced for as long as Undo can bring it back', () => {
    const t = setup(projectWith(ref('s1', A)));
    t.history.transact('Delete sample', (d) => void delete d.samples['s1' as SampleRef['id']]);
    expect([...collectHashes(t.doc())]).toEqual([]);
    expect([...t.history.referencedHashes()]).toEqual([A]);
  });

  it('keeps a sample referenced from the redo stack after an undo', () => {
    const t = setup(projectWith());
    t.history.transact('Add sample', (d) => void (d.samples['s2' as SampleRef['id']] = ref('s2', B) as never));
    t.history.undo();
    expect([...collectHashes(t.doc())]).toEqual([]);
    expect([...t.history.referencedHashes()]).toEqual([B]);
  });

  it('lets go once the step falls out of history (a new project clears it)', () => {
    const t = setup(projectWith(ref('s1', A)));
    t.history.transact('Delete sample', (d) => void delete d.samples['s1' as SampleRef['id']]);
    t.history.load(projectWith());
    expect(t.history.referencedHashes().size).toBe(0);
  });

  it('includes merged steps and gestures that were committed', () => {
    const t = setup(projectWith());
    t.history.transact('Add', (d) => void (d.samples['a' as SampleRef['id']] = ref('a', A) as never), { mergeKey: 'm' });
    t.history.transact('Add more', (d) => void (d.samples['b' as SampleRef['id']] = ref('b', B) as never), { mergeKey: 'm' });
    const g = t.history.gesture('Drag');
    g.update((d) => void (d.samples['c' as SampleRef['id']] = ref('c', C) as never));
    g.commit();
    expect([...t.history.referencedHashes()].sort()).toEqual([A, B, C]);
  });
});

describe('autosave files', () => {
  it('reads the hashes a thin autosave mentions without opening the project', () => {
    const p = projectWith(ref('s1', A), ref('s2', B));
    const data = writeProjectFile({ project: p, view: { note: `uses ${C}` }, samples: new Map(), appVersion: '0', now: new Date(0) });
    expect([...projectFileHashes(data)!].sort()).toEqual([A, B, C]);
  });

  it('names the samples a full project file embeds', () => {
    const p = projectWith(ref('s1', A));
    const data = writeProjectFile({
      project: p,
      view: null,
      samples: new Map([[A, { ext: 'wav', bytes: new Uint8Array([1, 2, 3]) }]]),
      appVersion: '0',
      now: new Date(0),
    });
    expect([...projectFileHashes(data)!]).toEqual([A]);
  });

  it('returns null for bytes that are not a project file', () => {
    expect(projectFileHashes(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(projectFileHashes(new Uint8Array(0))).toBeNull();
  });
});

describe('planCollection (the 7-day grace period)', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z');
  const blob = (hash: string, ageDays: number | undefined, size = 1000): BlobStat => ({
    hash,
    ext: 'wav',
    size,
    ...(ageDays === undefined ? {} : { modifiedAt: NOW - ageDays * DAY }),
  });
  const plan = (blobs: BlobStat[], referenced: string[], seen: Record<string, number> = {}) =>
    planCollection({ blobs, referenced: new Set(referenced), lastSeen: new Map(Object.entries(seen)), now: NOW });

  it('removes unreferenced blobs older than a week, and only those', () => {
    const p = plan([blob(A, 30), blob(B, 30), blob(C, 3), blob(D, 7.01)], [B]);
    expect(p.remove.map((x) => x.hash).sort()).toEqual([A, D]);
    expect(p.waiting.map((x) => x.hash)).toEqual([C]);
    expect(p.inUse).toBe(1);
    expect(p.removeBytes).toBe(2000);
  });

  it('keeps a blob written less than 7 days ago even though nothing refers to it', () => {
    const p = plan([blob(A, 6.99)], []);
    expect(p.remove).toEqual([]);
    expect(p.waiting[0]!.removableAt).toBe(NOW - 6.99 * DAY + GRACE_MS);
  });

  it('counts the last time it was seen in use, not only when it was written', () => {
    const old = blob(A, 90);
    expect(plan([old], [], { [A]: NOW - 2 * DAY }).remove).toEqual([]);
    expect(plan([old], [], { [A]: NOW - 8 * DAY }).remove.map((x) => x.hash)).toEqual([A]);
  });

  it('removes at exactly 7 days and not a millisecond sooner', () => {
    expect(plan([blob(A, 7)], []).remove.map((x) => x.hash)).toEqual([A]);
    expect(plan([{ hash: A, ext: 'wav', modifiedAt: NOW - GRACE_MS + 1 }], []).remove).toEqual([]);
  });

  it('starts the grace period at the first sighting when nothing says how old a blob is', () => {
    const p = plan([blob(A, undefined)], []);
    expect(p.remove).toEqual([]);
    expect(p.seen.get(A)).toBe(NOW);
  });

  it('never treats a time in the future (a clock that moved back) as old', () => {
    const p = plan([{ hash: A, ext: 'wav', modifiedAt: NOW + 30 * DAY }], []);
    expect(p.remove).toEqual([]);
  });

  it('marks blobs in use as seen now, but not on every pass', () => {
    const p = plan([blob(A, 40), blob(B, 40), blob(C, 40)], [A, B, C], { [A]: NOW - 1000, [B]: NOW - SEEN_REFRESH_MS - 1 });
    expect([...p.seen.keys()].sort()).toEqual([B, C]);
  });
});

describe('tabs', () => {
  const rec = (id: string, hashes: string[], over: Partial<TabRecord> = {}): TabRecord => ({
    v: 1,
    id,
    hashes,
    heartbeat: 1000,
    playing: false,
    busy: false,
    ...over,
  });

  it('trusts the records of tabs whose lock is held and discards the rest', () => {
    const c = classifyTabs([rec('a', [A]), rec('b', [B]), rec('c', [C])], new Set(['a', 'c']));
    expect(c.live.map((r) => r.id)).toEqual(['a', 'c']);
    expect(c.dead.map((r) => r.id)).toEqual(['b']);
    expect([...liveHashes(c.live)].sort()).toEqual([A, C]);
    expect(c.unknown).toEqual([]);
  });

  it('reports a tab that holds its lock but published nothing', () => {
    const c = classifyTabs([rec('a', [A])], new Set(['a', 'newcomer']));
    expect(c.unknown).toEqual(['newcomer']);
    expect(readiness(c, { idle: false })).toEqual({ ok: false, reason: 'tab-starting' });
  });

  it('always counts this tab, even before its lock shows up', () => {
    const c = classifyTabs([rec('me', [A])], new Set(), 'me');
    expect(c.live.map((r) => r.id)).toEqual(['me']);
    expect(c.unknown).toEqual([]);
  });

  it('waits for exports, and for playback only when idle', () => {
    const busy = classifyTabs([rec('a', [], { busy: true })], new Set(['a']));
    expect(readiness(busy, { idle: false })).toEqual({ ok: false, reason: 'busy' });
    const playing = classifyTabs([rec('a', [], { playing: true })], new Set(['a']));
    expect(readiness(playing, { idle: true })).toEqual({ ok: false, reason: 'playing' });
    expect(readiness(playing, { idle: false })).toEqual({ ok: true });
  });
});
