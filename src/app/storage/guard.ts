import { BLOBS_LOCK, createSharedHold } from '@platform/locks';
import type { BlobGuard } from '../persistence/blob-store';
import { seenKey, type GcKv } from './kv';

/** A mark younger than this isn't written again (the grace period is days; this only saves writes). */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

export interface BlobGuardOptions {
  kv: GcKv;
  /** Default: the shared `ag-blobs` Web Lock. */
  hold?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

/**
 * The sample store's safety net for clean-up: reads and writes of a blob happen under a shared lock
 * (a delete batch needs it exclusively, so it can't land in between), and each blob that is written,
 * looked up or read gets a "seen now" mark, which keeps it for the grace period no matter what refers
 * to it. A failed mark is never an error for the caller: without marks nothing is deleted early,
 * because every mark only ever adds protection.
 */
export function createBlobGuard(opts: BlobGuardOptions): BlobGuard {
  const hold = opts.hold ?? createSharedHold(BLOBS_LOCK);
  const now = opts.now ?? Date.now;
  const recent = new Map<string, number>();
  return {
    hold,
    async touch(hash) {
      const t = now();
      const last = recent.get(hash);
      if (last !== undefined && t - last < TOUCH_THROTTLE_MS && t >= last) return;
      try {
        await opts.kv.set([[seenKey(hash), t]]);
        recent.set(hash, t);
      } catch (e) {
        console.warn('Could not mark a sample as in use:', e);
      }
    },
  };
}
