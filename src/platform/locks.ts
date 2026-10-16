/**
 * Web Locks for session liveness. Each tab holds `agstudio:session:<id>` for as long as it runs; the
 * browser releases the lock when the tab closes or crashes. At startup, an autosave whose session
 * lock nobody holds belongs to a tab that is gone, which makes it a recovery candidate.
 */

export const SESSION_LOCK_PREFIX = 'agstudio:session:';

export function sessionLockName(sessionId: string): string {
  return SESSION_LOCK_PREFIX + sessionId;
}

export function isWebLocksAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

function locks(): LockManager {
  if (isWebLocksAvailable()) return navigator.locks;
  throw new Error('Web Locks are not available in this browser (they need https or localhost).');
}

/**
 * Takes the session's lock and holds it until the returned function is called (calling it again is a
 * no-op). Rejects if another tab or worker already holds it: session ids must be unique per tab.
 */
export function holdSessionLock(sessionId: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let release: () => void = () => {};
    const released = new Promise<void>((r) => (release = r));
    locks()
      .request(sessionLockName(sessionId), { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error(`Session ${sessionId} is already open in another tab.`));
          return;
        }
        resolve(() => release());
        return released;
      })
      .catch(reject);
  });
}

/** One clean-up of unused audio at a time, across every tab (held exclusively by the collector). */
export const GC_LOCK = 'ag-gc';
/**
 * Writers of the sample store hold this shared while they check for or write a blob; the collector holds
 * it exclusively for each batch it deletes, so a delete never lands between a writer's look and its use.
 */
export const BLOBS_LOCK = 'ag-blobs';

/**
 * Runs `fn` holding `name` exclusively. With `ifAvailable`, `fn` is not run when someone else holds it
 * (resolves `{ ran: false }`). Without Web Locks it resolves `{ ran: false }`: nothing can be coordinated.
 */
export async function withExclusiveLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ifAvailable?: boolean } = {},
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!isWebLocksAvailable()) return { ran: false };
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: opts.ifAvailable === true }, async (lock) => {
    if (!lock) return { ran: false } as const;
    return { ran: true, value: await fn() } as const;
  });
}

/**
 * Holds `name` shared while `fn` runs, however many callers overlap: the first takes the lock, the last
 * lets it go (one request, so a waiting exclusive request can't deadlock a nested one). Without Web
 * Locks it just runs `fn`.
 */
export function createSharedHold(name: string): <T>(fn: () => Promise<T>) => Promise<T> {
  let count = 0;
  let acquired: Promise<void> | null = null;
  let release: () => void = () => {};
  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      const done = new Promise<void>((r) => (release = r));
      navigator.locks
        .request(name, { mode: 'shared' }, () => {
          resolve();
          return done;
        })
        .catch(reject);
    });
  return async (fn) => {
    if (!isWebLocksAvailable()) return fn();
    if (count++ === 0) acquired = acquire();
    try {
      await acquired;
    } catch (e) {
      count--;
      throw e;
    }
    try {
      return await fn();
    } finally {
      if (--count === 0) release();
    }
  };
}

/** Ids of sessions whose lock is currently held (or requested) anywhere in this origin. */
export async function heldSessionLocks(): Promise<Set<string>> {
  const snapshot = await locks().query();
  const ids = new Set<string>();
  for (const info of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
    if (info.name?.startsWith(SESSION_LOCK_PREFIX)) ids.add(info.name.slice(SESSION_LOCK_PREFIX.length));
  }
  return ids;
}
