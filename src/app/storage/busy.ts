import type { Project } from '@core/model/types';
import { collectHashes } from '@core/gc/refs';

/**
 * Work in this tab that must not have audio taken from under it: an export or render, an import. While
 * any runs, the tab publishes itself as busy (no clean-up starts) and its audio stays pinned even if
 * the project no longer mentions it (a sample deleted while the export of the old state still runs).
 */

let busyCount = 0;
const pins = new Map<symbol, ReadonlySet<string>>();
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((fn) => fn());

/** Marks a long operation as running; call the result when it ends (it is safe to call twice). */
export function markBusy(opts: { project?: Project; hashes?: Iterable<string> } = {}): () => void {
  const id = Symbol('busy');
  busyCount++;
  const hashes = new Set<string>(opts.hashes ?? []);
  if (opts.project) collectHashes(opts.project, hashes);
  if (hashes.size > 0) pins.set(id, hashes);
  changed();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    busyCount--;
    pins.delete(id);
    changed();
  };
}

/** Runs `fn` as a busy operation (see `markBusy`). */
export async function whileBusy<T>(fn: () => Promise<T>, opts: Parameters<typeof markBusy>[0] = {}): Promise<T> {
  const done = markBusy(opts);
  try {
    return await fn();
  } finally {
    done();
  }
}

export const isBusy = () => busyCount > 0;

/** Hashes that running operations hold. */
export function pinnedHashes(into: Set<string> = new Set()): Set<string> {
  for (const set of pins.values()) for (const h of set) into.add(h);
  return into;
}

/** Calls `fn` when an operation starts or ends. */
export function onBusyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
