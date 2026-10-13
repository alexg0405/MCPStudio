/**
 * A tiny promise-based key-value store on IndexedDB (database `agstudio`, object store `kv`). Values
 * are stored by structured clone, so FileSystemHandles (sample folders, the last saved file) survive
 * reloads, which localStorage can't do.
 */

const DB_NAME = 'agstudio';
const STORE = 'kv';
const VERSION = 1;

let connection: Promise<IDBDatabase> | null = null;

export function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function open(): Promise<IDBDatabase> {
  if (connection) return connection;
  if (!isIdbAvailable()) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const forget = () => {
        if (connection === opening) connection = null;
      };
      // Another tab upgrading the database, or the browser closing the connection (storage cleared).
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened.'));
  });
  connection = opening;
  opening.catch(() => {
    if (connection === opening) connection = null;
  });
  return connection;
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
