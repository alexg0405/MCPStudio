import { collectHashes } from '@core/gc/refs';
import { planCollection, type BlobStat, type CollectionPlan } from '@core/gc/plan';
import {
  classifyTabs,
  isTabRecord,
  liveHashes,
  readiness,
  type TabClassification,
  type TabRecord,
} from '@core/gc/tabs';
import { projectFileHashes } from '@core/io/project-file';
import type { AutosaveFile, BlobStore } from '@platform/opfs';
import { BLOBS_LOCK, GC_LOCK, withExclusiveLock } from '@platform/locks';
import {
  ANALYSIS_PREFIX,
  DJ_LIBRARY_KEY,
  LAST_RUN_KEY,
  SEEN_PREFIX,
  TAB_PREFIX,
  seenKey,
  type GcKv,
  type GcLastRun,
} from './kv';

/**
 * Clean-up of unused audio: what is stored, what refers to it, and what may go. The rules, in order of
 * how much they protect:
 *
 *  1. Nothing is deleted unless every source of references was read successfully (a read that fails
 *     stops the run) and every open tab has published what it uses (an unknown tab stops the run).
 *  2. A blob that anything mentions is kept: every live tab's project and undo history, running
 *     operations, every autosave, the DJ library, and every other value in the app's IndexedDB.
 *  3. A blob written or last seen in use less than the grace period ago is kept, whatever refers to it.
 *  4. Each batch of deletes is re-checked inside an exclusive `ag-blobs` lock that readers and writers of
 *     the store hold shared, so a delete never lands between a tab's look at a blob and its use of it.
 *
 * Everything the collector touches arrives through `CollectorDeps`, so tests run it on fakes.
 */

export interface CollectorDeps {
  kv: GcKv;
  blobs: Pick<Required<BlobStore>, 'blobStats' | 'deleteBlob'>;
  autosaves: { files(): Promise<AutosaveFile[]> };
  /** Whether Web Locks exist (without them nothing can be coordinated, so nothing is deleted). */
  supported: boolean;
  /** Session ids whose life lock is held (the tabs that are alive). */
  heldTabs(): Promise<Set<string>>;
  /** Default: Web Locks. */
  exclusive?: typeof withExclusiveLock;
  /** This tab: its record is read from memory, never from storage. */
  self?: { id: string; record(): TabRecord };
  now?(): number;
  log?(message: string): void;
}

export interface References {
  classification: TabClassification;
  /** Everything that keeps a blob: the union of the sets below. */
  referenced: Set<string>;
  /** Open tabs (project, undo history, pinned operations) and autosaves. */
  projects: Set<string>;
  /** The DJ library's songs. */
  library: Set<string>;
  /** Any other value stored in the app's IndexedDB (presets, recent files…). */
  other: Set<string>;
  /** Dead tabs' hashes, with the time their tab was last alive. */
  deadSeen: Map<string, number>;
  deadIds: string[];
  autosaveBytes: number;
  autosaveCount: number;
  /** Autosave files that could not be read (corrupt). They count as holding nothing. */
  unreadableAutosaves: number;
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Reads every source of references. Throws when a source can't be read (callers then delete nothing). */
export async function gatherReferences(d: CollectorDeps): Promise<References> {
  const records: TabRecord[] = [];
  for (const [, value] of await d.kv.entries((k) => k.startsWith(TAB_PREFIX))) if (isTabRecord(value)) records.push(value);
  if (d.self) {
    const mine = d.self.record();
    const i = records.findIndex((r) => r.id === mine.id);
    if (i >= 0) records[i] = mine;
    else records.push(mine);
  }
  const classification = classifyTabs(records, await d.heldTabs(), d.self?.id);
  const projects = liveHashes(classification.live);

  let autosaveBytes = 0;
  let autosaveCount = 0;
  let unreadableAutosaves = 0;
  for (const file of await d.autosaves.files()) {
    autosaveCount++;
    autosaveBytes += file.size;
    const hashes = projectFileHashes(await file.read());
    if (hashes) for (const h of hashes) projects.add(h);
    else unreadableAutosaves++;
  }

  const library = new Set<string>();
  const other = new Set<string>();
  for (const [key, value] of await d.kv.entries((k) => !k.startsWith('gc:') && !k.startsWith(ANALYSIS_PREFIX))) {
    collectHashes(value, key === DJ_LIBRARY_KEY ? library : other);
  }

  const deadSeen = new Map<string, number>();
  for (const r of classification.dead) for (const h of r.hashes) deadSeen.set(h, Math.max(deadSeen.get(h) ?? 0, r.heartbeat));

  return {
    classification,
    referenced: new Set([...projects, ...library, ...other]),
    projects,
    library,
    other,
    deadSeen,
    deadIds: classification.dead.map((r) => r.id),
    autosaveBytes,
    autosaveCount,
    unreadableAutosaves,
  };
}

/** The "last seen" marks stored so far. */
async function loadSeen(kv: GcKv): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [key, value] of await kv.entries((k) => k.startsWith(SEEN_PREFIX)))
    if (isNumber(value)) out.set(key.slice(SEEN_PREFIX.length), value);
  return out;
}

/** What a clean-up would do now: the facts and the plan, with nothing written or deleted. */
export interface Preview {
  plan: CollectionPlan;
  refs: References;
  blobs: BlobStat[];
  /** Why a run would not start right now (a tab is busy or starting), if so. */
  blocked?: 'tab-starting' | 'busy' | 'playing';
}

export async function previewCollection(d: CollectorDeps, opts: { idle?: boolean } = {}): Promise<Preview> {
  const now = (d.now ?? Date.now)();
  const refs = await gatherReferences(d);
  const seen = await loadSeen(d.kv);
  for (const [h, t] of refs.deadSeen) seen.set(h, Math.max(seen.get(h) ?? 0, t));
  const blobs = await d.blobs.blobStats();
  const plan = planCollection({ blobs, referenced: refs.referenced, lastSeen: seen, now });
  const ready = readiness(refs.classification, { idle: opts.idle === true });
  return { plan, refs, blobs, ...(ready.ok ? {} : { blocked: ready.reason }) };
}

export type CollectResult =
  | { status: 'done' | 'dry-run'; removed: number; bytes: number; failed: number; kept: number; waiting: number }
  | { status: 'skipped'; reason: 'unsupported' | 'locked' | 'tab-starting' | 'busy' | 'playing' | 'stopped' | 'error'; removed?: number; error?: unknown };

export interface CollectOptions {
  /** Find what would go and log it; delete nothing. */
  dryRun?: boolean;
  /** The automatic run: also waits for playback. */
  idle?: boolean;
  /** Blobs per batch (each batch is one exclusive lock hold). */
  batch?: number;
  /** Called between batches; true stops the run (playback started, the tab is closing). */
  shouldStop?(): boolean;
  /** Called between batches so the page can breathe. */
  pause?(): Promise<void>;
  /** Progress after each batch. */
  onProgress?(done: number, total: number): void;
}

/**
 * Removes unused audio. One run at a time across all tabs (`ag-gc`); a run that finds the lock taken, a
 * tab starting up or busy, or anything unreadable does nothing and says why.
 */
export async function collectGarbage(d: CollectorDeps, opts: CollectOptions = {}): Promise<CollectResult> {
  if (!d.supported) return { status: 'skipped', reason: 'unsupported' };
  const exclusive = d.exclusive ?? withExclusiveLock;
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  try {
    const got = await exclusive(GC_LOCK, () => run(), { ifAvailable: true });
    return got.ran ? got.value : { status: 'skipped', reason: 'locked' };
  } catch (error) {
    return { status: 'skipped', reason: 'error', error };
  }

  async function run(): Promise<CollectResult> {
    const refs = await gatherReferences(d);
    const ready = readiness(refs.classification, { idle: opts.idle === true });
    if (!ready.ok) return { status: 'skipped', reason: ready.reason };

    const seen = await loadSeen(d.kv);
    const t0 = now();
    // Tabs that died: their audio counts as seen when they last were alive; then their records go.
    const folded = new Map(seen);
    for (const [h, t] of refs.deadSeen) folded.set(h, Math.max(folded.get(h) ?? 0, t));
    const blobs = await d.blobs.blobStats();
    const plan = planCollection({ blobs, referenced: refs.referenced, lastSeen: folded, now: t0 });
    const kept = plan.inUse + plan.waiting.length;

    if (opts.dryRun) {
      const mb = (plan.removeBytes / 1048576).toFixed(1);
      log(
        `Storage cleanup (dry run): would remove ${plan.remove.length} unused audio files (${mb} MB); ` +
          `${plan.inUse} in use, ${plan.waiting.length} unused but inside the grace period.` +
          (plan.remove.length ? `\n  ${plan.remove.map((b) => b.hash.slice(0, 12)).join(' ')}` : ''),
      );
      await d.kv.set([[LAST_RUN_KEY, { at: t0, removed: plan.remove.length, bytes: plan.removeBytes, dryRun: true } satisfies GcLastRun]]);
      return { status: 'dry-run', removed: plan.remove.length, bytes: plan.removeBytes, failed: 0, kept, waiting: plan.waiting.length };
    }

    // Marks first: hashes in use are seen now; dead tabs' hashes at their last heartbeat.
    const marks = new Map<string, number>();
    for (const [h, t] of folded) if (t !== seen.get(h)) marks.set(h, t);
    for (const [h, t] of plan.seen) marks.set(h, Math.max(marks.get(h) ?? 0, t));
    await d.kv.set([...marks].map(([h, t]) => [seenKey(h), t] as const));
    if (refs.deadIds.length) await d.kv.del(refs.deadIds.map((id) => `${TAB_PREFIX}${id}`));

    let removed = 0;
    let bytes = 0;
    let failed = 0;
    const size = opts.batch ?? 20;
    for (let i = 0; i < plan.remove.length; i += size) {
      if (opts.shouldStop?.()) {
        await record(removed, bytes);
        return { status: 'skipped', reason: 'stopped', removed };
      }
      const batch = plan.remove.slice(i, i + size);
      const result = await exclusive(BLOBS_LOCK, () => deleteBatch(batch), {});
      if (!result.ran) break;
      removed += result.value.removed.length;
      bytes += result.value.removed.reduce((n, b) => n + (b.size ?? 0), 0);
      failed += result.value.failed;
      opts.onProgress?.(Math.min(plan.remove.length, i + size), plan.remove.length);
      if (result.value.stop) break;
      await opts.pause?.();
    }
    await record(removed, bytes);
    log(`Storage cleanup: removed ${removed} unused audio files (${(bytes / 1048576).toFixed(1)} MB).`);
    return { status: 'done', removed, bytes, failed, kept, waiting: plan.waiting.length };
  }

  async function record(removed: number, bytes: number) {
    await d.kv.set([[LAST_RUN_KEY, { at: now(), removed, bytes, dryRun: false } satisfies GcLastRun]]).catch(() => {});
  }

  /** One batch, inside the exclusive blobs lock: look again at what the tabs use, then delete what is still free. */
  async function deleteBatch(batch: readonly BlobStat[]): Promise<{ removed: BlobStat[]; failed: number; stop: boolean }> {
    const records: TabRecord[] = [];
    for (const [, v] of await d.kv.entries((k) => k.startsWith(TAB_PREFIX))) if (isTabRecord(v)) records.push(v);
    if (d.self) {
      const mine = d.self.record();
      const i = records.findIndex((r) => r.id === mine.id);
      if (i >= 0) records[i] = mine;
      else records.push(mine);
    }
    const c = classifyTabs(records, await d.heldTabs(), d.self?.id);
    // A tab that appeared since we started could use anything: stop and let the next run decide.
    if (c.unknown.length > 0) return { removed: [], failed: 0, stop: true };
    const fresh = liveHashes(c.live);
    const seen = new Map<string, number>();
    for (const [k, v] of await d.kv.getMany(batch.map((b) => seenKey(b.hash)))) if (isNumber(v)) seen.set(k.slice(SEEN_PREFIX.length), v);
    const again = planCollection({ blobs: batch, referenced: fresh, lastSeen: seen, now: now() });
    // The marks and the autosave/library sources were checked by the plan; only newer use matters here.
    const removed: BlobStat[] = [];
    let failed = 0;
    for (const blob of again.remove) {
      try {
        await d.blobs.deleteBlob(blob.hash);
        removed.push(blob);
      } catch (e) {
        failed++;
        log(`Storage cleanup: could not remove ${blob.hash.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (removed.length) {
      // Their marks and cached analyses go with them.
      const hashes = new Set(removed.map((b) => b.hash));
      const analyses = await d.kv.keys((k) => k.startsWith(ANALYSIS_PREFIX) && hashes.has(k.slice(k.lastIndexOf(':') + 1)));
      await d.kv.del([...removed.map((b) => seenKey(b.hash)), ...analyses]).catch(() => {});
    }
    return { removed, failed, stop: false };
  }
}
