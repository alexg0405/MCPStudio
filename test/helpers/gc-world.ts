import { sha256Hex } from '@core/io/hash';
import { History } from '@core/history/history';
import { createEmptyProject } from '@core/model/defaults';
import type { Project, SampleRef } from '@core/model/types';
import { createBlobGuard } from '@app/storage/guard';
import { memoryKv } from '@app/storage/kv';
import { startTabRefs, type TabRefs } from '@app/storage/tab-refs';
import type { CollectorDeps } from '@app/storage/collector';
import { createSampleStore, installBlobGuard, type SampleStore } from '@app/persistence/blob-store';
import { heldSessionLocks, isWebLocksAvailable, sessionLockName } from '@platform/locks';
import { createOpfsStorage, isOpfsAvailable, type OpfsStorage } from '@platform/opfs';

/**
 * The clean-up of unused audio against the real browser: OPFS for the blobs and autosaves, IndexedDB for
 * the records, Web Locks for tab liveness and for the collector. A "tab" here is an iframe that holds the
 * tab's life lock (removing the iframe is the tab closing: the browser releases its lock) plus its own
 * project, undo history and published record. Time is a fake clock moved forward by days, so the blobs
 * written now are "old" without waiting a week.
 */

export const supported = isOpfsAvailable() && isWebLocksAvailable();
export const DAY = 24 * 60 * 60 * 1000;

let counter = 0;
const roots: string[] = [];

export async function scratch(label: string): Promise<OpfsStorage> {
  const name = `agstudio-test-gc-${label}-${Date.now()}-${counter++}`;
  const opfs = await navigator.storage.getDirectory();
  roots.push(name);
  const dir = await opfs.getDirectoryHandle(name, { create: true });
  return createOpfsStorage({ root: async () => dir });
}

/**
 * The records' store. An in-memory one: other test files share this origin's IndexedDB (and one of them
 * deletes the database), while OPFS and Web Locks, which these tests do exercise for real, are not shared
 * that way. The IndexedDB implementation has its own tests (platform/idb.browser.test.ts).
 */
export const scopedKv = () => memoryKv();

export async function cleanupGc(): Promise<void> {
  installBlobGuard(null);
  const opfs = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) await opfs.removeEntry(name, { recursive: true }).catch(() => {});
}

export const ref = (id: string, hash: string): SampleRef => ({ id: id as SampleRef['id'], name: id, source: { kind: 'embedded', hash, ext: 'wav' } });
export const projectOf = (...refs: SampleRef[]): Project => ({
  ...createEmptyProject({ title: 'Song', now: new Date(0) }),
  samples: Object.fromEntries(refs.map((r) => [r.id, r])) as Project['samples'],
});

export interface Env {
  storage: OpfsStorage;
  kv: ReturnType<typeof scopedKv>;
  store: SampleStore;
  /** Days the fake clock is ahead of the real one. */
  skew: { days: number };
  now(): number;
  prefix: string;
  deps(self?: Tab): CollectorDeps;
}

export async function env(): Promise<Env> {
  const storage = await scratch('s');
  const kv = scopedKv();
  const skew = { days: 0 };
  const now = () => Date.now() + skew.days * DAY;
  const prefix = `gc${counter++}-`;
  const guard = createBlobGuard({ kv, now });
  const store = createSampleStore(storage, { guard });
  return {
    storage,
    kv,
    store,
    skew,
    now,
    prefix,
    deps: (self) => ({
      kv,
      blobs: storage,
      autosaves: { files: () => storage.autosaveFiles() },
      supported: true,
      // Only the tabs of this test (other test files may hold session locks of their own).
      heldTabs: async () => new Set([...(await heldSessionLocks())].filter((id) => id.startsWith(prefix))),
      ...(self ? { self: { id: self.id, record: self.refs.record } } : {}),
      now,
    }),
  };
}

export interface Tab {
  id: string;
  refs: TabRefs;
  history: History;
  doc(): Project;
  /** The tab goes away: its lock is released, its record stays behind. */
  close(): void;
  /** Waits until the browser shows the lock as gone. */
  closed: Promise<void>;
}

/** An open tab: an iframe holding the tab's life lock, with a project and its undo history. */
export async function openTab(e: Env, name: string, project: Project): Promise<Tab> {
  const id = `${e.prefix}${name}`;
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.append(iframe);
  await new Promise<void>((resolve, reject) => {
    iframe.contentWindow!.navigator.locks
      .request(sessionLockName(id), { mode: 'exclusive' }, () => {
        resolve();
        return new Promise<void>(() => {}); // held until the iframe goes
      })
      .catch(reject);
  });
  let doc = project;
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  const listeners = new Set<() => void>();
  history.onChange(() => listeners.forEach((fn) => fn()));
  const refs = startTabRefs({
    id,
    kv: e.kv,
    project: () => doc,
    history,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    isPlaying: () => false,
    now: e.now,
  });
  await refs.publishNow();
  return {
    id,
    refs,
    history,
    doc: () => doc,
    close() {
      refs.stop();
      iframe.remove();
    },
    get closed() {
      return until(async () => !(await heldSessionLocks()).has(id));
    },
  };
}

export async function until(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A blob of `size` bytes: written through the guarded store. Returns its reference. */
export async function put(e: Env, n: number, size = 2048): Promise<{ hash: string; ref: SampleRef; size: number }> {
  const bytes = new Uint8Array(size).fill(n & 255);
  bytes[0] = n & 255;
  bytes[1] = (n >> 8) & 255;
  const hash = await sha256Hex(bytes);
  await e.store.putBlob(hash, 'wav', bytes);
  return { hash, ref: ref(`s${n}`, hash), size };
}

export const stored = async (e: Env) => (await e.storage.listBlobs()).map((b) => b.hash).sort();

