import { afterEach, describe, expect, it } from 'vitest';
import { idbDel, idbDelMany, idbEntries, idbGet, idbGetMany, idbKeys, idbRaiseMany, idbSet, idbSetMany, isIdbAvailable } from './idb';

const PREFIX = 'test:idb:';
const key = (k: string) => PREFIX + k;

afterEach(async () => {
  for (const k of await idbKeys()) if (typeof k === 'string' && k.startsWith(PREFIX)) await idbDel(k);
});

describe.skipIf(!isIdbAvailable())('IndexedDB key-value store', () => {
  it('sets, gets, overwrites and deletes values', async () => {
    expect(await idbGet(key('missing'))).toBeUndefined();
    await idbSet(key('a'), { n: 1 });
    expect(await idbGet(key('a'))).toEqual({ n: 1 });
    await idbSet(key('a'), 'two');
    expect(await idbGet<string>(key('a'))).toBe('two');
    await idbDel(key('a'));
    expect(await idbGet(key('a'))).toBeUndefined();
    await idbDel(key('a')); // deleting a missing key is fine
  });

  it('lists keys', async () => {
    await idbSet(key('x'), 1);
    await idbSet(key('y'), 2);
    const keys = (await idbKeys()).filter((k) => typeof k === 'string' && k.startsWith(PREFIX));
    expect(keys.sort()).toEqual([key('x'), key('y')]);
  });

  it('writes, reads and deletes several entries at once', async () => {
    await idbSetMany([
      [key('m1'), { n: 1 }],
      [key('m2'), 'two'],
      [key('m3'), 3],
    ]);
    expect(await idbGetMany([key('m1'), key('m3'), key('nope')])).toEqual(
      new Map<string, unknown>([
        [key('m1'), { n: 1 }],
        [key('m3'), 3],
      ]),
    );
    const some = await idbEntries((k) => k.startsWith(key('m')) && k !== key('m2'));
    expect(some.sort()).toEqual([[key('m1'), { n: 1 }], [key('m3'), 3]]);
    await idbDelMany([key('m1'), key('m2')]);
    expect(await idbGet(key('m1'))).toBeUndefined();
    expect(await idbGet(key('m3'))).toBe(3);
    await idbSetMany([]);
    await idbDelMany([]);
    expect((await idbGetMany([])).size).toBe(0);
  });

  it('raises numbers without ever lowering one', async () => {
    await idbSet(key('t'), 100);
    await idbRaiseMany([
      [key('t'), 50],
      [key('u'), 7],
    ]);
    expect(await idbGet(key('t'))).toBe(100);
    expect(await idbGet(key('u'))).toBe(7);
    await idbRaiseMany([[key('t'), 200]]);
    expect(await idbGet(key('t'))).toBe(200);
    await idbSet(key('s'), 'not a number');
    await idbRaiseMany([[key('s'), 1]]);
    expect(await idbGet(key('s'))).toBe(1);
  });

  it('stores values by structured clone', async () => {
    const value = { when: new Date(5), bytes: Uint8Array.from([1, 2]), map: new Map([['k', 1]]), nested: [null, true] };
    await idbSet(key('clone'), value);
    const got = await idbGet<typeof value>(key('clone'));
    expect(got).toEqual(value);
    expect(got).not.toBe(value);
    expect(got?.when).toBeInstanceOf(Date);
  });

  it('stores FileSystemHandles', async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('agstudio-test-idb', { create: true });
    try {
      const file = await dir.getFileHandle('x.wav', { create: true });
      await idbSet(key('dir'), dir);
      await idbSet(key('file'), file);
      const gotDir = await idbGet<FileSystemDirectoryHandle>(key('dir'));
      const gotFile = await idbGet<FileSystemFileHandle>(key('file'));
      expect(gotDir?.kind).toBe('directory');
      expect(await gotDir?.isSameEntry(dir)).toBe(true);
      expect(gotFile?.name).toBe('x.wav');
      expect(await gotFile?.isSameEntry(file)).toBe(true);
    } finally {
      await root.removeEntry('agstudio-test-idb', { recursive: true });
    }
  });

  it('adds its store to a database that other code created at a higher version', async () => {
    await idbSet(key('x'), 1);
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase('agstudio'); // our open connection closes itself
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('agstudio', 5);
      req.onupgradeneeded = () => req.result.createObjectStore('other');
      req.onsuccess = () => (req.result.close(), resolve());
      req.onerror = () => reject(req.error);
    });
    await idbSet(key('y'), 2);
    expect(await idbGet(key('y'))).toBe(2);
    const stores = await new Promise<string[]>((resolve, reject) => {
      const req = indexedDB.open('agstudio');
      req.onsuccess = () => {
        const names = [...req.result.objectStoreNames];
        req.result.close();
        resolve(names);
      };
      req.onerror = () => reject(req.error);
    });
    expect(stores.sort()).toEqual(['kv', 'other']);
  });

  it('fails instead of hanging when another connection blocks the upgrade, then recovers', async () => {
    await idbSet(key('x'), 1);
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase('agstudio');
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });
    // Another tab's connection (no kv store, ignores versionchange) keeps the database open.
    const foreign = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('agstudio', 3);
      req.onupgradeneeded = () => req.result.createObjectStore('other');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await expect(idbGet(key('x'))).rejects.toThrow('in use by another AGstudio tab');
    foreign.close();
    expect(await idbGet(key('x'))).toBeUndefined();
    await idbSet(key('x'), 2);
    expect(await idbGet(key('x'))).toBe(2);
  });

  it('reconnects after the database is deleted under it', async () => {
    await idbSet(key('before'), 1);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('agstudio');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    expect(await idbGet(key('before'))).toBeUndefined();
    await idbSet(key('after'), 2);
    expect(await idbGet(key('after'))).toBe(2);
  });
});
