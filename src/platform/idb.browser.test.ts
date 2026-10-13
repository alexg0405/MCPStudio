import { afterEach, describe, expect, it } from 'vitest';
import { idbDel, idbGet, idbKeys, idbSet, isIdbAvailable } from './idb';

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
