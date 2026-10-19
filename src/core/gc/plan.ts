/**
 * Deciding what a clean-up may remove. Pure: the app gathers the facts (what is stored, what anything
 * refers to, when each blob was last seen) and this says what goes. The rule is one line: a blob goes
 * only when nothing refers to it AND it was neither written nor last seen in use within the grace
 * period. Anything unclear keeps the blob.
 */

/** A blob is kept this long after it was last written or last seen in use. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** A hash still in use is marked "seen" again once its mark is this old (not on every pass). */
export const SEEN_REFRESH_MS = 12 * 60 * 60 * 1000;

/**
 * What a clean-up knows about one stored audio file: its hash and extension, and its size and last write time when the
 * store can say.
 */
export interface BlobStat {
  hash: string;
  ext: string;
  /** Bytes (absent when the store can't say). */
  size?: number;
  /** When the file was last written (ms; absent when the store can't say). */
  modifiedAt?: number;
}

/**
 * The facts a clean-up decides from: the stored files, every hash anything refers to, when each hash was last seen
 * (ms), the time now (ms) and an optional grace period (ms).
 */
export interface PlanInput {
  blobs: readonly BlobStat[];
  /** Every hash anything refers to. */
  referenced: ReadonlySet<string>;
  /** When each hash was last seen in use or written (ms). */
  lastSeen: ReadonlyMap<string, number>;
  now: number;
  graceMs?: number;
}

/**
 * What a clean-up should do: which files to remove, which are waiting out their grace period, how many are in use, and
 * the new "last seen" marks to store.
 */
export interface CollectionPlan {
  /** Blobs nothing refers to and that are past the grace period. */
  remove: BlobStat[];
  /** Blobs nothing refers to but that are inside the grace period (with the time they become removable). */
  waiting: Array<BlobStat & { removableAt: number }>;
  /** How many blobs something refers to. */
  inUse: number;
  /** New "last seen" marks to store (hashes still in use, and blobs seen for the first time). */
  seen: Map<string, number>;
  removeBytes: number;
  waitingBytes: number;
}

/** The newest time that counts for a blob; undefined when nothing says (first sighting). */
export function lastActivity(blob: BlobStat, seen: number | undefined): number | undefined {
  if (seen === undefined) return blob.modifiedAt;
  return blob.modifiedAt === undefined ? seen : Math.max(seen, blob.modifiedAt);
}

/**
 * Decides what a clean-up may remove: only files nothing refers to and that have been neither written nor seen in use
 * during the grace period.
 */
export function planCollection(input: PlanInput): CollectionPlan {
  const { now, referenced, lastSeen } = input;
  const grace = input.graceMs ?? GRACE_MS;
  const plan: CollectionPlan = { remove: [], waiting: [], inUse: 0, seen: new Map(), removeBytes: 0, waitingBytes: 0 };
  for (const blob of input.blobs) {
    const seen = lastSeen.get(blob.hash);
    if (referenced.has(blob.hash)) {
      plan.inUse++;
      if (seen === undefined || now - seen >= SEEN_REFRESH_MS) plan.seen.set(blob.hash, now);
      continue;
    }
    const last = lastActivity(blob, seen);
    if (last === undefined) {
      // Never seen and no file time: its grace period starts now.
      plan.seen.set(blob.hash, now);
      plan.waiting.push({ ...blob, removableAt: now + grace });
      plan.waitingBytes += blob.size ?? 0;
    } else if (last <= now && now - last >= grace) {
      // A time in the future (a clock that moved back) never counts as old.
      plan.remove.push(blob);
      plan.removeBytes += blob.size ?? 0;
    } else {
      plan.waiting.push({ ...blob, removableAt: last + grace });
      plan.waitingBytes += blob.size ?? 0;
    }
  }
  return plan;
}
