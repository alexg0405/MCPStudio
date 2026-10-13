import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@core/io/hash';
import { StorageError, createOpfsStorage, isOpfsAvailable, type AutosaveMeta, type OpfsStorage } from './opfs';

const available = isOpfsAvailable();
const suffix = available ? '' : ' (skipped: OPFS is not available in this browser)';
const TEST_ROOT = 'agstudio-test-opfs';

let root: FileSystemDirectoryHandle;
let store: OpfsStorage;

async function opfsRoot() {
  return navigator.storage.getDirectory();
}

beforeEach(async () => {
  if (!available) return;
  await (await opfsRoot()).removeEntry(TEST_ROOT, { recursive: true }).catch(() => {});
  root = await (await opfsRoot()).getDirectoryHandle(TEST_ROOT, { create: true });
  store = createOpfsStorage({ root: async () => root });
});

afterEach(async () => {
  if (available) await (await opfsRoot()).removeEntry(TEST_ROOT, { recursive: true }).catch(() => {});
});

const bytesOf = (...values: number[]) => Uint8Array.from(values);

async function blob(...values: number[]) {
  const bytes = bytesOf(...values);
  return { bytes, hash: await sha256Hex(bytes) };
}

async function fileNames(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  return names.sort();
}

async function writeRaw(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array | string) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>));
  await w.close();
}

describe.skipIf(!available)(`OPFS blob store${suffix}`, () => {
  it('puts, gets, lists and deletes blobs', async () => {
    const a = await blob(1, 2, 3);
    const b = await blob(4, 5);
    expect(await store.listBlobs()).toEqual([]);
    expect(await store.getBlob(a.hash)).toBeNull();
    await store.putBlob(a.hash, 'wav', a.bytes);
    await store.putBlob(b.hash, 'aif', b.bytes);
    expect(await store.hasBlob(a.hash)).toBe(true);
    expect(await store.getBlob(a.hash)).toEqual({ ext: 'wav', bytes: a.bytes });
    expect(await store.getBlob(b.hash, 'aif')).toEqual({ ext: 'aif', bytes: b.bytes });
    expect(await store.listBlobs()).toEqual(
      [
        { hash: a.hash, ext: 'wav' },
        { hash: b.hash, ext: 'aif' },
      ].sort((x, y) => (x.hash < y.hash ? -1 : 1)),
    );
    expect(await fileNames(await root.getDirectoryHandle('blobs'))).toEqual([`${a.hash}.wav`, `${b.hash}.aif`].sort());
    await store.deleteBlob(a.hash);
    expect(await store.hasBlob(a.hash)).toBe(false);
    expect(await store.getBlob(a.hash, 'wav')).toBeNull();
    expect(await store.listBlobs()).toEqual([{ hash: b.hash, ext: 'aif' }]);
    await store.deleteBlob(a.hash); // already gone: no error
  });

  it('normalizes extensions and finds blobs with a wrong or missing hint', async () => {
    const a = await blob(9, 9, 9);
    await store.putBlob(a.hash, '.WAV', a.bytes);
    expect(await fileNames(await root.getDirectoryHandle('blobs'))).toEqual([`${a.hash}.wav`]);
    const fresh = createOpfsStorage({ root: async () => root }); // empty cache, like another tab
    expect(await fresh.getBlob(a.hash, 'wave')).toEqual({ ext: 'wav', bytes: a.bytes });
    expect(await fresh.hasBlob(a.hash, 'WAV')).toBe(true);
    expect(await fresh.getBlob(a.hash)).toEqual({ ext: 'wav', bytes: a.bytes });
  });

  it('keeps one copy per hash and replaces a damaged copy', async () => {
    const a = await blob(1, 2, 3, 4);
    await store.putBlob(a.hash, 'wav', a.bytes);
    await store.putBlob(a.hash, 'aiff', a.bytes); // same content under another name: not stored twice
    expect(await store.listBlobs()).toEqual([{ hash: a.hash, ext: 'wav' }]);
    const blobs = await root.getDirectoryHandle('blobs');
    await writeRaw(blobs, `${a.hash}.wav`, bytesOf(1)); // truncated by some accident
    await store.putBlob(a.hash, 'wav', a.bytes);
    expect((await store.getBlob(a.hash))?.bytes).toEqual(a.bytes);
  });

  it('replaces a damaged copy stored under another extension', async () => {
    const a = await blob(1, 2, 3, 4);
    const blobs = await root.getDirectoryHandle('blobs', { create: true });
    await writeRaw(blobs, `${a.hash}.aif`, bytesOf(1, 2)); // wrong size: damaged
    await store.putBlob(a.hash, 'wav', a.bytes);
    expect(await fileNames(blobs)).toEqual([`${a.hash}.wav`]);
    expect(await store.getBlob(a.hash)).toEqual({ ext: 'wav', bytes: a.bytes });
  });

  it('treats invalid extension hints as no hint', async () => {
    const a = await blob(4, 4);
    await store.putBlob(a.hash, 'wav', a.bytes);
    for (const hint of ['../x', 'a/b', '', 'waytoolongextension']) {
      expect(await store.getBlob(a.hash, hint)).toEqual({ ext: 'wav', bytes: a.bytes });
      expect(await store.hasBlob(a.hash, hint)).toBe(true);
    }
  });

  it('sees blobs written by another store instance', async () => {
    const other = createOpfsStorage({ root: async () => root });
    const a = await blob(7);
    expect(await store.hasBlob(a.hash)).toBe(false);
    await other.putBlob(a.hash, 'flac', a.bytes);
    expect(await store.getBlob(a.hash)).toEqual({ ext: 'flac', bytes: a.bytes });
  });

  it('accepts bytes in SharedArrayBuffer memory', async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([5, 6, 7, 8]);
    const hash = await sha256Hex(shared);
    await store.putBlob(hash, 'wav', shared);
    expect((await store.getBlob(hash))?.bytes).toEqual(bytesOf(5, 6, 7, 8));
  });

  it('rejects invalid hashes and extensions with StorageError', async () => {
    const a = await blob(1);
    await expect(store.putBlob('nope', 'wav', a.bytes)).rejects.toBeInstanceOf(StorageError);
    await expect(store.putBlob(a.hash, 'w/v', a.bytes)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.deleteBlob('../x')).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.getBlob('nope')).toBeNull();
    expect(await store.hasBlob('nope')).toBe(false);
  });

  it('ignores foreign files in the blob folder', async () => {
    const blobs = await root.getDirectoryHandle('blobs', { create: true });
    await writeRaw(blobs, 'notes.txt', 'hello');
    await writeRaw(blobs, `${'a'.repeat(64)}.wav.crswap`, 'partial');
    expect(await store.listBlobs()).toEqual([]);
  });
});

describe.skipIf(!available)(`OPFS autosave slots${suffix}`, () => {
  const meta = (over: Partial<AutosaveMeta> = {}): AutosaveMeta => ({
    sessionId: 's1',
    projectId: 'prj_one',
    title: 'Song',
    savedAt: '2026-10-12T10:00:00.000Z',
    clean: false,
    slot: 'a',
    ...over,
  });

  it('writes slots and reads back the newest valid one', async () => {
    await store.writeAutosave('s1', 'a', bytesOf(1, 1), meta({ savedAt: '2026-10-12T10:00:00.000Z' }));
    await store.writeAutosave(
      's1',
      'b',
      bytesOf(2, 2, 2),
      meta({ savedAt: '2026-10-12T10:00:03.000Z', fileKey: 'file:1' }),
    );
    const got = await store.readAutosave('s1');
    expect(got?.data).toEqual(bytesOf(2, 2, 2));
    expect(got?.meta).toEqual(meta({ slot: 'b', savedAt: '2026-10-12T10:00:03.000Z', fileKey: 'file:1' }));
    expect(await fileNames(await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('s1'))).toEqual([
      'a.agproj',
      'a.json',
      'b.agproj',
      'b.json',
    ]);
    await store.writeAutosave('s1', 'a', bytesOf(3), meta({ savedAt: '2026-10-12T10:00:06.000Z' }));
    expect((await store.readAutosave('s1'))?.data).toEqual(bytesOf(3));
  });

  it('forces the slot and session id in the stored meta', async () => {
    await store.writeAutosave('s2', 'b', bytesOf(1), meta({ sessionId: 'other', slot: 'a' }));
    expect((await store.readAutosave('s2'))?.meta).toMatchObject({ sessionId: 's2', slot: 'b' });
  });

  it('falls back to the older slot when the newest data is damaged', async () => {
    await store.writeAutosave('s1', 'a', bytesOf(1, 1), meta({ savedAt: '2026-10-12T10:00:00.000Z' }));
    await store.writeAutosave('s1', 'b', bytesOf(2, 2), meta({ slot: 'b', savedAt: '2026-10-12T10:00:03.000Z' }));
    const dir = await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('s1');
    await writeRaw(dir, 'b.agproj', bytesOf(9, 9)); // same size, different content (interrupted save)
    const got = await store.readAutosave('s1');
    expect(got?.data).toEqual(bytesOf(1, 1));
    expect(got?.meta.slot).toBe('a');
    await writeRaw(dir, 'a.agproj', bytesOf(1)); // now both are bad
    expect(await store.readAutosave('s1')).toBeNull();
  });

  it('ignores slots whose meta file is missing or unreadable', async () => {
    await store.writeAutosave('s1', 'a', bytesOf(1), meta());
    const dir = await (await root.getDirectoryHandle('autosave')).getDirectoryHandle('s1');
    await writeRaw(dir, 'b.agproj', bytesOf(5)); // data written, meta never was
    await writeRaw(dir, 'b.json', '{"v":1,"slot":"b"'); // truncated JSON
    expect((await store.readAutosave('s1'))?.meta.slot).toBe('a');
    expect(await store.readAutosave('nobody')).toBeNull();
  });

  it('lists one entry per session, newest first', async () => {
    expect(await store.listAutosaves()).toEqual([]);
    await store.writeAutosave('old', 'a', bytesOf(1), meta({ sessionId: 'old', savedAt: '2026-10-01T00:00:00.000Z' }));
    await store.writeAutosave('new', 'a', bytesOf(1), meta({ sessionId: 'new', savedAt: '2026-10-12T00:00:00.000Z' }));
    await store.writeAutosave(
      'new',
      'b',
      bytesOf(2),
      meta({ sessionId: 'new', slot: 'b', savedAt: '2026-10-12T00:00:05.000Z' }),
    );
    const autosave = await root.getDirectoryHandle('autosave');
    await autosave.getDirectoryHandle('empty', { create: true });
    await writeRaw(autosave, 'stray.txt', 'x');
    const list = await store.listAutosaves();
    expect(list.map((m) => [m.sessionId, m.slot])).toEqual([
      ['new', 'b'],
      ['old', 'a'],
    ]);
  });

  it('marks the newest slot clean and keeps it readable', async () => {
    await store.writeAutosave('s1', 'a', bytesOf(1), meta({ savedAt: '2026-10-12T10:00:00.000Z' }));
    await store.writeAutosave('s1', 'b', bytesOf(2), meta({ slot: 'b', savedAt: '2026-10-12T10:00:03.000Z' }));
    await store.markAutosaveClean('s1');
    const [listed] = await store.listAutosaves();
    expect(listed).toMatchObject({ sessionId: 's1', slot: 'b', clean: true });
    expect(await store.readAutosave('s1')).toMatchObject({ data: bytesOf(2), meta: { clean: true } });
    // The next write starts dirty again.
    await store.writeAutosave('s1', 'a', bytesOf(3), meta({ savedAt: '2026-10-12T10:00:06.000Z' }));
    expect((await store.listAutosaves())[0]).toMatchObject({ slot: 'a', clean: false });
    await store.markAutosaveClean('missing-session'); // no-op
  });

  it('deletes a session', async () => {
    await store.writeAutosave('s1', 'a', bytesOf(1), meta());
    await store.writeAutosave('s2', 'a', bytesOf(1), meta({ sessionId: 's2' }));
    await store.deleteAutosave('s1');
    expect((await store.listAutosaves()).map((m) => m.sessionId)).toEqual(['s2']);
    expect(await store.readAutosave('s1')).toBeNull();
    await store.deleteAutosave('s1'); // already gone
  });

  it('rejects unsafe session ids and unknown slots', async () => {
    await expect(store.writeAutosave('../evil', 'a', bytesOf(1), meta())).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.writeAutosave('s1', 'c' as 'a', bytesOf(1), meta())).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.readAutosave('a/b')).rejects.toBeInstanceOf(StorageError);
  });
});
