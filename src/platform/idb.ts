/**
 * A tiny promise-based key-value store on IndexedDB (database `agstudio`, object store `kv`). Values
 * are stored by structured clone, so FileSystemHandles (sample folders, the last saved file) survive
 * reloads, which localStorage can't do.
 */

const DB_NAME = 'agstudio';
const STORE = 'kv';

let connection: Promise<IDBDatabase> | null = null;

export function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Opens the database at `version` (default: whatever version it has, 1 when new). */
function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      // An upgrade that was blocked can still complete later; we already gave up on it.
      if (failed) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened.'));
    // An upgrade waits until every other connection closes. A connection that ignores versionchange
    // (e.g. an older build in another tab) would make it wait forever, so fail instead.
    req.onblocked = () => {
      failed = true;
      reject(new Error('Browser storage is in use by another AGstudio tab. Close other tabs and try again.'));
    };
  });
}

function open(): Promise<IDBDatabase> {
  if (connection) return connection;
  if (!isIdbAvailable()) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  const opening = (async () => {
    // Not pinned to a version, so other code may add object stores to this database later.
    let db = await openAt();
    if (!db.objectStoreNames.contains(STORE)) {
      const next = db.version + 1;
      db.close();
      db = await openAt(next);
    }
    const forget = () => {
      if (connection === opening) connection = null;
    };
    // Another connection upgrading the database, or the browser closing ours (storage cleared).
    db.onversionchange = () => {
      db.close();
      forget();
    };
    db.onclose = forget;
    return db;
  })();
  connection = opening;
  opening.catch(() => {
    if (connection === opening) connection = null;
  });
  return opening;
}

async function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
  retry = true,
): Promise<T> {
  const db = await open();
  let tx: IDBTransaction;
  try {
    tx = db.transaction(STORE, mode);
  } catch (e) {
    // The connection was closed under us (InvalidStateError): reopen once.
    connection = null;
    if (retry) return run(mode, op, false);
    throw e;
  }
  return new Promise<T>((resolve, reject) => {
    const req = op(tx.objectStore(STORE));
    // Resolve on commit so a write is durable (and a read consistent) before callers continue.
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}

export async function idbGet<T = unknown>(key: IDBValidKey): Promise<T | undefined> {
  return (await run('readonly', (s) => s.get(key))) as T | undefined;
}

export async function idbSet(key: IDBValidKey, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key));
}

export async function idbDel(key: IDBValidKey): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
}

export async function idbKeys(): Promise<IDBValidKey[]> {
  return run('readonly', (s) => s.getAllKeys());
}

/**
 * The string-keyed entries whose key passes `keep`, read in one transaction (values of the other keys
 * are never read). Used for records that live under a key prefix.
 */
export async function idbEntries(keep: (key: string) => boolean): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  await run('readonly', (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && keep(cursor.key)) out.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    return req;
  });
  return out;
}

/** Values for several keys, read in one transaction (missing keys are left out). */
export async function idbGetMany(keys: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (keys.length === 0) return out;
  await run('readonly', (store) => {
    let last: IDBRequest<unknown> | undefined;
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result !== undefined) out.set(key, req.result);
      };
      last = req;
    }
    return last as IDBRequest<unknown>;
  });
  return out;
}

/** Writes several entries in one transaction (all or none). */
export async function idbSetMany(entries: ReadonlyArray<readonly [IDBValidKey, unknown]>): Promise<void> {
  if (entries.length === 0) return;
  await run('readwrite', (store) => {
    let last: IDBRequest<IDBValidKey> | undefined;
    for (const [key, value] of entries) last = store.put(value, key);
    return last as IDBRequest<IDBValidKey>;
  });
}

/** Deletes several keys in one transaction. */
export async function idbDelMany(keys: readonly IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  await run('readwrite', (store) => {
    let last: IDBRequest<undefined> | undefined;
    for (const key of keys) last = store.delete(key);
    return last as IDBRequest<undefined>;
  });
}
