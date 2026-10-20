import { beforeEach, describe, expect, it } from 'vitest';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project, SampleRef } from '@core/model/types';
import { emptySong, songWithClips, withClip, withFader, withPattern } from '@core/versions/test-songs';
import { DEFAULT_RETENTION } from '@core/versions/retention';
import { memoryKv } from '../storage/kv';
import { memoryVersionFiles } from './memory';
import { VersionError, VersionStore } from './store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-20T12:00:00Z');
const hex = (n: number) => n.toString(16).padStart(64, '0');

beforeEach(() => setIdSource(seededBytes(11)));

function rig() {
  const kv = memoryKv();
  const files = memoryVersionFiles();
  const clock = { now: START };
  const store = new VersionStore({ kv, files, appVersion: 'test', now: () => clock.now });
  return { kv, files, clock, store };
}

const withSample = (project: Project, hash: string): Project => {
  const ref: SampleRef = { id: `smp_${hash.slice(-4)}` as SampleRef['id'], name: 'Kick', source: { kind: 'embedded', hash, ext: 'wav' } };
  return { ...project, samples: { ...project.samples, [ref.id]: ref } };
};

describe('VersionStore.create', () => {
  it('stores a version the project can be read back from, exactly', async () => {
    const { store } = rig();
    const song = songWithClips(3, 'Night Drive');
    const record = (await store.create({ project: song, view: { mode: 'song' }, reason: 'timer' }))!;
    expect(record).toMatchObject({ projectId: song.projectId, reason: 'timer', pinned: false, title: 'Night Drive' });
    expect(record.facts).toMatchObject({ bars: 3, clips: 3 });
    const loaded = await store.read(record);
    expect(loaded.project).toEqual(song);
    expect(loaded.view).toEqual({ mode: 'song' });
  });

  it('does not make a second version of the same song', async () => {
    const { store, clock } = rig();
    const song = songWithClips(2);
    const first = await store.create({ project: song, view: null, reason: 'save' });
    clock.now += 5 * 60_000;
    expect(await store.create({ project: structuredClone(song), view: null, reason: 'timer' })).toBeNull();
    expect(await store.list(song.projectId)).toHaveLength(1);
    expect((await store.list(song.projectId))[0]!.id).toBe(first!.id);
  });

  it('puts a name on the newest version when asked to name an unchanged song, and pins it', async () => {
    const { store } = rig();
    const song = songWithClips(2);
    await store.create({ project: song, view: null, reason: 'timer' });
    const named = (await store.create({ project: song, view: null, reason: 'named', name: 'Before vocals' }))!;
    expect(named).toMatchObject({ name: 'Before vocals', pinned: true });
    const list = await store.list(song.projectId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Before vocals', pinned: true });
  });

  it('pins a version that has a name', async () => {
    const { store } = rig();
    const record = (await store.create({ project: emptySong(), view: null, reason: 'named', name: 'Start' }))!;
    expect(record.pinned).toBe(true);
  });

  it('says what changed since the version before it', async () => {
    const { store, clock } = rig();
    const first = songWithClips(2);
    await store.create({ project: first, view: null, reason: 'timer' });
    clock.now += 60_000;
    const withDrop = withPattern(first, 'Drop 2').project;
    const second = withFader(withClip(withClip(withDrop, first.patternOrder[0]!, 5), first.patternOrder[0]!, 6), 1, 0.794328);
    const record = (await store.create({ project: second, view: null, reason: 'timer' }))!;
    expect(record.changes[0]).toBe("new pattern 'Drop 2'");
    expect(record.changes).toContain('+2 clips');
    expect(record.summary).toMatch(/^new pattern 'Drop 2', \+2 clips, mixer: .* −2\.0 dB$/);
  });

  it('works out what changed from storage when the earlier project is not at hand', async () => {
    const { store, clock } = rig();
    const first = songWithClips(1);
    await store.create({ project: first, view: null, reason: 'timer' });
    clock.now += 60_000;
    const record = (await store.create({ project: withClip(first, first.patternOrder[0]!, 4), view: null, reason: 'timer' }))!;
    expect(record.changes).toEqual(['+1 clip']);
  });

  it('calls the very first one the first version', async () => {
    const { store } = rig();
    const record = (await store.create({ project: emptySong(), view: null, reason: 'save' }))!;
    expect(record.changes).toEqual(['first version']);
    expect(record.summary).toBe('First version of this project');
  });

  it('remembers every sample the song needs', async () => {
    const { store } = rig();
    const record = (await store.create({ project: withSample(withSample(emptySong(), hex(1)), hex(2)), view: null, reason: 'save' }))!;
    expect(new Set(record.hashes)).toEqual(new Set([hex(1), hex(2)]));
  });

  it('keeps projects apart', async () => {
    const { store } = rig();
    const a = songWithClips(1, 'A');
    const b = songWithClips(2, 'B');
    await store.create({ project: a, view: null, reason: 'save' });
    await store.create({ project: b, view: null, reason: 'save' });
    expect(await store.list(a.projectId)).toHaveLength(1);
    expect(await store.list(b.projectId)).toHaveLength(1);
    expect([...(await store.listAll()).keys()].sort()).toEqual([a.projectId, b.projectId].sort());
  });

  it('lists newest first', async () => {
    const { store, clock } = rig();
    let song = songWithClips(1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.now += 1000;
      song = withClip(song, song.patternOrder[0]!, 10 + i);
      ids.push((await store.create({ project: song, view: null, reason: 'timer' }))!.id);
    }
    expect((await store.list(song.projectId)).map((r) => r.id)).toEqual([...ids].reverse());
  });
});

describe('VersionStore changes', () => {
  it('renames, pins and unpins; naming pins', async () => {
    const { store } = rig();
    const record = (await store.create({ project: emptySong(), view: null, reason: 'timer' }))!;
    const pinned = await store.update(record, { pinned: true });
    expect(pinned.pinned).toBe(true);
    const unpinned = await store.update(pinned, { pinned: false });
    expect(unpinned.pinned).toBe(false);
    const named = await store.update(unpinned, { name: '  Chorus idea  ' });
    expect(named).toMatchObject({ name: 'Chorus idea', pinned: true });
    const unnamed = await store.update(named, { name: '' });
    expect(unnamed.name).toBeUndefined();
    expect((await store.list(record.projectId))[0]).toEqual(unnamed);
  });

  it('deletes the file and the record', async () => {
    const { store, files, kv } = rig();
    const record = (await store.create({ project: emptySong(), view: null, reason: 'timer' }))!;
    await store.remove(record);
    expect(files.files.size).toBe(0);
    expect([...kv.data.keys()]).toEqual([]);
    await expect(store.read(record)).rejects.toBeInstanceOf(VersionError);
  });

  it('measures how much the versions take', async () => {
    const { store, clock } = rig();
    const a = songWithClips(1, 'A');
    const b = songWithClips(1, 'B');
    const ra = (await store.create({ project: a, view: null, reason: 'timer' }))!;
    clock.now += 1000;
    const rb = (await store.create({ project: b, view: null, reason: 'timer' }))!;
    expect(await store.usage(a.projectId)).toEqual({ count: 1, bytes: ra.size });
    expect(await store.usage()).toEqual({ count: 2, bytes: ra.size + rb.size });
  });
});

describe('VersionStore.prune', () => {
  it('applies the retention schedule, keeping pinned and the newest', async () => {
    const { store, clock } = rig();
    let song = emptySong();
    const kept: string[] = [];
    const gone: string[] = [];
    const make = async (ageMs: number, extra: { pinned?: boolean; name?: string } = {}) => {
      clock.now = START - ageMs;
      song = withClip(song, song.patternOrder[0]!, Math.floor(ageMs / HOUR));
      return (await store.create({ project: song, view: null, reason: 'timer', ...extra }))!;
    };
    // Oldest first so each version's "what changed" has a version before it.
    gone.push((await make(60 * DAY)).id);
    kept.push((await make(59 * DAY, { name: 'Release' })).id); // named: pinned
    gone.push((await make(20 * DAY + 2 * HOUR)).id); // same day as the next one, older
    kept.push((await make(20 * DAY + HOUR)).id);
    kept.push((await make(2 * HOUR)).id);
    clock.now = START;
    const removed = await store.prune(song.projectId, DEFAULT_RETENTION, 0);
    expect(removed.map((r) => r.id).sort()).toEqual(gone.sort());
    expect((await store.list(song.projectId)).map((r) => r.id).sort()).toEqual(kept.sort());
  });
});

describe('VersionStore.reconcile', () => {
  it('drops a record whose file is gone', async () => {
    const { store, files } = rig();
    const record = (await store.create({ project: emptySong(), view: null, reason: 'timer' }))!;
    files.files.clear();
    expect(await store.reconcile()).toEqual({ dropped: 1, adopted: 0 });
    expect(await store.list(record.projectId)).toEqual([]);
  });

  it('adopts a file whose record was never written, so no version is lost', async () => {
    const { store, kv } = rig();
    const song = songWithClips(2, 'Interrupted');
    const record = (await store.create({ project: withSample(song, hex(9)), view: null, reason: 'timer' }))!;
    kv.data.clear(); // the write was interrupted after the file
    expect(await store.list(song.projectId)).toEqual([]);
    expect(await store.reconcile()).toEqual({ dropped: 0, adopted: 1 });
    const [adopted] = await store.list(song.projectId);
    expect(adopted).toMatchObject({ id: record.id, title: 'Interrupted' });
    expect(adopted!.hashes).toContain(hex(9));
    expect((await store.read(adopted!)).project.projectId).toBe(song.projectId);
  });

  it('leaves a file it cannot read alone', async () => {
    const { store, files } = rig();
    files.files.set('prj_x/ver_broken', { bytes: new Uint8Array([1, 2, 3]), modifiedAt: 0 });
    expect(await store.reconcile()).toEqual({ dropped: 0, adopted: 0 });
    expect(files.files.has('prj_x/ver_broken')).toBe(true);
  });
});

describe('what is stored', () => {
  it('is the project compressed, far smaller than its JSON for a big song', async () => {
    const { store } = rig();
    let song = emptySong();
    const patternId = song.patternOrder[0]!;
    for (let bar = 0; bar < 400; bar++) song = withClip(song, patternId, bar);
    const record = (await store.create({ project: song, view: null, reason: 'save' }))!;
    const json = JSON.stringify(song).length;
    expect(record.size).toBeLessThan(json / 3);
  });
});
