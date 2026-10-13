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

/** Ids of sessions whose lock is currently held (or requested) anywhere in this origin. */
export async function heldSessionLocks(): Promise<Set<string>> {
  const snapshot = await locks().query();
  const ids = new Set<string>();
  for (const info of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
    if (info.name?.startsWith(SESSION_LOCK_PREFIX)) ids.add(info.name.slice(SESSION_LOCK_PREFIX.length));
  }
  return ids;
}
