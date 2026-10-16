import { planCollection } from '@core/gc/plan';
import { gatherReferences, type CollectorDeps } from './collector';
import { SEEN_PREFIX } from './kv';

/** How much browser storage AGstudio uses, by what it holds. The rows add up to `total`. */
export interface StorageUsage {
  /** Audio that open projects, their undo history or autosaves use. */
  projectAudio: Bucket;
  /** Songs in the DJ library. */
  djLibrary: Bucket;
  /** Time-stretched copies of long clips (a cache; made again when needed). */
  stretched: Bucket;
  /** Autosave files, and audio nothing uses any more. */
  other: Bucket & { autosaveBytes: number; unusedBytes: number };
  total: number;
  /** Audio nothing uses: how much goes now, and how much waits out the one-week grace period. */
  unused: { removable: Bucket; waiting: Bucket };
}

export interface Bucket {
  files: number;
  bytes: number;
}

const empty = (): Bucket => ({ files: 0, bytes: 0 });

export async function measureUsage(
  d: CollectorDeps & { derived?: { usage(): Promise<Bucket> } },
): Promise<StorageUsage> {
  const now = (d.now ?? Date.now)();
  const refs = await gatherReferences(d);
  const blobs = await d.blobs.blobStats();
  const seen = new Map<string, number>();
  for (const [k, v] of await d.kv.entries((k) => k.startsWith(SEEN_PREFIX))) if (typeof v === 'number') seen.set(k.slice(SEEN_PREFIX.length), v);
  for (const [h, t] of refs.deadSeen) seen.set(h, Math.max(seen.get(h) ?? 0, t));
  const plan = planCollection({ blobs, referenced: refs.referenced, lastSeen: seen, now });

  const projectAudio = empty();
  const djLibrary = empty();
  const unusedFiles = { files: 0, bytes: 0 };
  for (const b of blobs) {
    const bytes = b.size ?? 0;
    const into = refs.library.has(b.hash) ? djLibrary : refs.referenced.has(b.hash) ? projectAudio : unusedFiles;
    into.files++;
    into.bytes += bytes;
  }
  const stretched = (await d.derived?.usage().catch(() => null)) ?? empty();
  const other = { files: refs.autosaveCount + unusedFiles.files, bytes: refs.autosaveBytes + unusedFiles.bytes, autosaveBytes: refs.autosaveBytes, unusedBytes: unusedFiles.bytes };
  return {
    projectAudio,
    djLibrary,
    stretched: { files: stretched.files, bytes: stretched.bytes },
    other,
    total: projectAudio.bytes + djLibrary.bytes + stretched.bytes + other.bytes,
    unused: {
      removable: { files: plan.remove.length, bytes: plan.removeBytes },
      waiting: { files: plan.waiting.length, bytes: plan.waitingBytes },
    },
  };
}
