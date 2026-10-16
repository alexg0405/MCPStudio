import { collectHashes } from '@core/gc/refs';
import { TAB_RECORD_VERSION, type TabRecord } from '@core/gc/tabs';
import type { Project } from '@core/model/types';
import { isBusy, onBusyChange, pinnedHashes } from './busy';
import { tabKey, type GcKv } from './kv';

/** How often a tab says it is alive (and re-publishes). Timers in background tabs run about once a minute. */
export const HEARTBEAT_MS = 30_000;
/** A change is published this long after the last edit (edits come in bursts). */
const PUBLISH_DELAY_MS = 1000;

export interface TabRefsOptions {
  /** This tab's session id: the same one its life lock `agstudio:session:<id>` is held under. */
  id: string;
  kv: GcKv;
  project(): Project;
  /** What undo and redo could bring back (History). */
  history: { referencedHashes(into: Set<string>): Set<string> };
  /** Subscribes to anything that changes the hashes (document, undo steps); returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  isPlaying(): boolean;
  now?: () => number;
  heartbeatMs?: number;
}

export interface TabRefs {
  /** What this tab uses right now, computed fresh: its project, its undo and redo history and running operations. */
  hashes(): Set<string>;
  /** The record this tab publishes. */
  record(): TabRecord;
  /** Writes the record now (resolves when stored). */
  publishNow(): Promise<void>;
  /** Stops publishing. The record stays: after the tab's lock goes it still says when the tab was last alive. */
  stop(): void;
}

/**
 * Publishes what this tab uses into IndexedDB (a small record per tab id) so a clean-up in any tab sees
 * it. Refreshed shortly after every change and on a heartbeat, so a record is never older than a heartbeat
 * plus a publish delay (the grace period covers anything written in between: see app/storage/guard.ts).
 */
export function startTabRefs(opts: TabRefsOptions): TabRefs {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let writing: Promise<void> = Promise.resolve();

  const hashes = () => {
    const out = collectHashes(opts.project());
    opts.history.referencedHashes(out);
    return pinnedHashes(out);
  };
  const record = (): TabRecord => ({
    v: TAB_RECORD_VERSION,
    id: opts.id,
    hashes: [...hashes()].sort(),
    heartbeat: now(),
    playing: opts.isPlaying(),
    busy: isBusy(),
  });
  const publishNow = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped) return writing;
    const rec = record();
    writing = writing
      .catch(() => {})
      .then(() => opts.kv.set([[tabKey(opts.id), rec]]))
      .catch((e) => console.warn('Could not publish which audio this tab uses:', e));
    return writing;
  };
  const schedule = () => {
    if (stopped) return;
    timer ??= setTimeout(() => void publishNow(), PUBLISH_DELAY_MS);
  };

  const offs = [opts.subscribe(schedule), onBusyChange(() => void publishNow())];
  const beat = setInterval(() => void publishNow(), opts.heartbeatMs ?? HEARTBEAT_MS);
  void publishNow();

  return {
    hashes,
    record,
    publishNow,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearInterval(beat);
      offs.forEach((off) => off());
    },
  };
}
