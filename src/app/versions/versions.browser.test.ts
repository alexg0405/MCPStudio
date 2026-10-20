import { afterEach, describe, expect, it } from 'vitest';
import { emptySong, songWithClips, withClip } from '@core/versions/test-songs';
import { StorageError, createVersionFiles, isOpfsAvailable, type VersionFileStore } from '@platform/opfs';
import { zipOffThread } from '../persistence/zip-async';
import { memoryKv } from '../storage/kv';
import { VersionStore } from './store';

const available = isOpfsAvailable();
const suffix = available ? '' : ' (skipped: OPFS is not available in this browser)';
const TEST_ROOT = 'agstudio-test-versions';

async function scratch(): Promise<{ files: VersionFileStore; dir: FileSystemDirectoryHandle }> {
  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry(TEST_ROOT, { recursive: true }).catch(() => {});
  const dir = await opfs.getDirectoryHandle(TEST_ROOT, { create: true });
  return { files: createVersionFiles(async () => dir), dir };
}

afterEach(async () => {
  if (available) await (await navigator.storage.getDirectory()).removeEntry(TEST_ROOT, { recursive: true }).catch(() => {});
});

describe.skipIf(!available)(`version files in OPFS${suffix}`, () => {
  it('writes, reads, lists and removes a version file, and removes the folder of the last one', async () => {
    const { files, dir } = await scratch();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    expect(await files.read('prj_a', 'ver_1')).toBeNull();
    await files.write('prj_a', 'ver_1', bytes);
    await files.write('prj_a', 'ver_2', Uint8Array.from([9]));
    await files.write('prj_b', 'ver_3', Uint8Array.from([7, 7]));
    expect(await files.read('prj_a', 'ver_1')).toEqual(bytes);
    const listed = await files.list();
    expect(listed.map((f) => `${f.projectId}/${f.versionId}:${f.size}`).sort()).toEqual(['prj_a/ver_1:4', 'prj_a/ver_2:1', 'prj_b/ver_3:2']);
    expect(listed.every((f) => f.modifiedAt > 0)).toBe(true);

    await files.remove('prj_b', 'ver_3');
    expect(await files.read('prj_b', 'ver_3')).toBeNull();
    const versions = await dir.getDirectoryHandle('versions');
    const folders: string[] = [];
    for await (const name of versions.keys()) folders.push(name);
    expect(folders).toEqual(['prj_a']); // prj_b had no versions left, so its folder went
    await files.remove('prj_a', 'ver_does_not_exist'); // nothing to remove is not an error
  });

  it('replaces a file whole, and refuses names that are not plain ids', async () => {
    const { files } = await scratch();
    await files.write('prj_a', 'ver_1', Uint8Array.from([1, 1, 1, 1, 1]));
    await files.write('prj_a', 'ver_1', Uint8Array.from([2]));
    expect(await files.read('prj_a', 'ver_1')).toEqual(Uint8Array.from([2]));
    await expect(files.write('../evil', 'ver_1', Uint8Array.from([1]))).rejects.toBeInstanceOf(StorageError);
    await expect(files.write('prj_a', 'a/b', Uint8Array.from([1]))).rejects.toBeInstanceOf(StorageError);
  });

  it('keeps versions made with the Worker compressor and reads them back exactly', async () => {
    const { files } = await scratch();
    const store = new VersionStore({ kv: memoryKv(), files, appVersion: 'test', zip: zipOffThread });
    const song = songWithClips(3, 'In a browser');
    const first = (await store.create({ project: song, view: { layout: 'x' }, reason: 'timer' }))!;
    const second = (await store.create({ project: withClip(song, song.patternOrder[0]!, 9), view: null, reason: 'timer' }))!;
    expect((await store.read(first)).project).toEqual(song);
    expect(second.changes).toEqual(['+1 clip']);
    expect(first.size).toBeGreaterThan(100);
    // What is on disk is what the record says.
    const stored = await files.list();
    expect(stored.find((f) => f.versionId === first.id)?.size).toBe(first.size);
    await store.remove(first);
    expect((await files.list()).map((f) => f.versionId)).toEqual([second.id]);
  });

  it('adopts a file whose record was never written', async () => {
    const { files } = await scratch();
    const kv = memoryKv();
    const store = new VersionStore({ kv, files, appVersion: 'test', zip: zipOffThread });
    const song = emptySong('Interrupted');
    const record = (await store.create({ project: song, view: null, reason: 'timer' }))!;
    kv.data.clear();
    expect(await store.reconcile()).toEqual({ dropped: 0, adopted: 1 });
    const [adopted] = await store.list(song.projectId);
    expect(adopted!.id).toBe(record.id);
    expect((await store.read(adopted!)).project.meta.title).toBe('Interrupted');
  });
});
