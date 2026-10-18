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
  DJ_LIBRARY_KEY,
  isAnalysisKey,
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

const BYTES_PER_MB = 1_048_576;
/** Hashes in log lines are shortened to this many characters. */
const SHORT_HASH_LENGTH = 12;
/** Blobs deleted per batch when the caller doesn't say (each batch is one hold of the exclusive lock). */
const DEFAULT_BATCH_SIZE = 20;

/** The tab records in storage, with this tab's own record (from memory) in place of its stored one. */
async function readTabRecords(d: CollectorDeps): Promise<TabRecord[]> {
  const records: TabRecord[] = [];
  for (const [, value] of await d.kv.entries((k) => k.startsWith(TAB_PREFIX))) {
    if (isTabRecord(value)) records.push(value);
  }
  if (d.self) {
    const mine = d.self.record();
    const index = records.findIndex((r) => r.id === mine.id);
    if (index >= 0) records[index] = mine;
    else records.push(mine);
  }
  return records;
}

/** Reads every source of references. Throws when a source can't be read (callers then delete nothing). */
export async function gatherReferences(d: CollectorDeps): Promise<References> {
  const records = await readTabRecords(d);
  const classification = classifyTabs(records, await d.heldTabs(), d.self?.id);
  const projects = liveHashes(classification.live);

  let autosaveBytes = 0;
  let autosaveCount = 0;
  let unreadableAutosaves = 0;
  for (const file of await d.autosaves.files()) {
    autosaveCount++;
    autosaveBytes += file.size;
    const hashes = projectFileHashes(await file.read());
    if (hashes) for (const hash of hashes) projects.add(hash);
    else unreadableAutosaves++;
  }

  const library = new Set<string>();
  const other = new Set<string>();
  for (const [key, value] of await d.kv.entries((k) => !k.startsWith('gc:') && !isAnalysisKey(k))) {
    collectHashes(value, key === DJ_LIBRARY_KEY ? library : other);
  }

  const deadSeen = new Map<string, number>();
  for (const record of classification.dead) {
    for (const hash of record.hashes) deadSeen.set(hash, Math.max(deadSeen.get(hash) ?? 0, record.heartbeat));
  }

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
  const seen = new Map<string, number>();
  for (const [key, value] of await kv.entries((k) => k.startsWith(SEEN_PREFIX))) {
    if (isNumber(value)) seen.set(key.slice(SEEN_PREFIX.length), value);
  }
  return seen;
}

/**
 * The stored marks plus what dead tabs used, each counted as seen when its tab was last alive (a copy;
 * `seen` is not changed).
 */
function withDeadTabSightings(
  seen: ReadonlyMap<string, number>,
  deadSeen: ReadonlyMap<string, number>,
): Map<string, number> {
  const folded = new Map(seen);
  for (const [hash, time] of deadSeen) folded.set(hash, Math.max(folded.get(hash) ?? 0, time));
  return folded;
}

/** What a clean-up would do now: the facts and the plan, with nothing written or deleted. */
export interface Preview {
  plan: CollectionPlan;
  refs: References;
  blobs: BlobStat[];
  /** Why a run would not start right now (a tab is busy or starting), if so. */
  blocked?: 'tab-starting' | 'busy' | 'playing';
}

/** Works out what a clean-up would remove now, without touching anything. */
export async function previewCollection(d: CollectorDeps, opts: { idle?: boolean } = {}): Promise<Preview> {
  const now = (d.now ?? Date.now)();
  const refs = await gatherReferences(d);
  const seen = withDeadTabSightings(await loadSeen(d.kv), refs.deadSeen);
  const blobs = await d.blobs.blobStats();
  const plan = planCollection({ blobs, referenced: refs.referenced, lastSeen: seen, now });
  const ready = readiness(refs.classification, { idle: opts.idle === true });
  return { plan, refs, blobs, ...(ready.ok ? {} : { blocked: ready.reason }) };
}

export type CollectResult =
  | { status: 'done' | 'dry-run'; removed: number; bytes: number; failed: number; kept: number; waiting: number }
  | {
      status: 'skipped';
      reason: 'unsupported' | 'locked' | 'tab-starting' | 'busy' | 'playing' | 'stopped' | 'error';
      removed?: number;
      error?: unknown;
    };

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
  try {
    const got = await exclusive(GC_LOCK, () => runCollection(d, opts), { ifAvailable: true });
    return got.ran ? got.value : { status: 'skipped', reason: 'locked' };
  } catch (error) {
    return { status: 'skipped', reason: 'error', error };
  }
}

/** One collection, inside the `ag-gc` lock: read everything, plan, then (unless a dry run) delete in batches. */
async function runCollection(d: CollectorDeps, opts: CollectOptions): Promise<CollectResult> {
  const now = d.now ?? Date.now;
  const refs = await gatherReferences(d);
  const ready = readiness(refs.classification, { idle: opts.idle === true });
  if (!ready.ok) return { status: 'skipped', reason: ready.reason };

  const seen = await loadSeen(d.kv);
  const startedAt = now();
  // Tabs that died: their audio counts as seen when they last were alive; then their records go.
  const folded = withDeadTabSightings(seen, refs.deadSeen);
  const blobs = await d.blobs.blobStats();
  const plan = planCollection({ blobs, referenced: refs.referenced, lastSeen: folded, now: startedAt });
  const kept = plan.inUse + plan.waiting.length;

  if (opts.dryRun) return finishDryRun(d, plan, kept, startedAt);

  // Marks first: hashes in use are seen now; dead tabs' hashes at their last heartbeat.
  const marks = new Map<string, number>();
  for (const [hash, time] of folded) if (time !== seen.get(hash)) marks.set(hash, time);
  for (const [hash, time] of plan.seen) marks.set(hash, Math.max(marks.get(hash) ?? 0, time));
  await d.kv.raise([...marks].map(([hash, time]) => [seenKey(hash), time] as const));
  if (refs.deadIds.length) await d.kv.del(refs.deadIds.map((id) => `${TAB_PREFIX}${id}`));

  const outcome = await deleteInBatches(d, plan, opts);
  await recordLastRun(d, outcome.removed, outcome.bytes);
  if (outcome.stoppedEarly) return { status: 'skipped', reason: 'stopped', removed: outcome.removed };
  const log = d.log ?? (() => {});
  log(
    `Storage cleanup: removed ${outcome.removed} unused audio files (${(outcome.bytes / BYTES_PER_MB).toFixed(1)} MB).`,
  );
  return {
    status: 'done',
    removed: outcome.removed,
    bytes: outcome.bytes,
    failed: outcome.failed,
    kept,
    waiting: plan.waiting.length,
  };
}

/** A dry run: logs what would be removed and records the run, deleting nothing. */
async function finishDryRun(
  d: CollectorDeps,
  plan: CollectionPlan,
  kept: number,
  startedAt: number,
): Promise<CollectResult> {
  const log = d.log ?? (() => {});
  const mb = (plan.removeBytes / BYTES_PER_MB).toFixed(1);
  log(
    `Storage cleanup (dry run): would remove ${plan.remove.length} unused audio files (${mb} MB); ` +
      `${plan.inUse} in use, ${plan.waiting.length} unused but inside the grace period.` +
      (plan.remove.length ? `\n  ${plan.remove.map((b) => b.hash.slice(0, SHORT_HASH_LENGTH)).join(' ')}` : ''),
  );
  const lastRun: GcLastRun = { at: startedAt, removed: plan.remove.length, bytes: plan.removeBytes, dryRun: true };
  await d.kv.set([[LAST_RUN_KEY, lastRun]]);
  return {
    status: 'dry-run',
    removed: plan.remove.length,
    bytes: plan.removeBytes,
    failed: 0,
    kept,
    waiting: plan.waiting.length,
  };
}

/** The totals of the delete loop, and whether the caller asked it to stop before the end. */
interface DeleteOutcome {
  removed: number;
  bytes: number;
  failed: number;
  stoppedEarly: boolean;
}

/** Deletes the planned blobs a batch at a time, each batch under the exclusive blobs lock. */
async function deleteInBatches(d: CollectorDeps, plan: CollectionPlan, opts: CollectOptions): Promise<DeleteOutcome> {
  const exclusive = d.exclusive ?? withExclusiveLock;
  let removed = 0;
  let bytes = 0;
  let failed = 0;
  const batchSize = opts.batch ?? DEFAULT_BATCH_SIZE;
  for (let i = 0; i < plan.remove.length; i += batchSize) {
    if (opts.shouldStop?.()) return { removed, bytes, failed, stoppedEarly: true };
    const batch = plan.remove.slice(i, i + batchSize);
    const result = await exclusive(BLOBS_LOCK, () => deleteBatch(d, batch), {});
    if (!result.ran) break;
    removed += result.value.removed.length;
    bytes += result.value.removed.reduce((n, b) => n + (b.size ?? 0), 0);
    failed += result.value.failed;
    opts.onProgress?.(Math.min(plan.remove.length, i + batchSize), plan.remove.length);
    if (result.value.stop) break;
    await opts.pause?.();
  }
  return { removed, bytes, failed, stoppedEarly: false };
}

/** Remembers the run (for "last clean-up" in the UI); a failure to remember is not worth failing for. */
async function recordLastRun(d: CollectorDeps, removed: number, bytes: number): Promise<void> {
  const now = d.now ?? Date.now;
  const lastRun: GcLastRun = { at: now(), removed, bytes, dryRun: false };
  await d.kv.set([[LAST_RUN_KEY, lastRun]]).catch(() => {});
}

/** One batch, inside the exclusive blobs lock: look again at what the tabs use, then delete what is still free. */
async function deleteBatch(
  d: CollectorDeps,
  batch: readonly BlobStat[],
): Promise<{ removed: BlobStat[]; failed: number; stop: boolean }> {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const records = await readTabRecords(d);
  const tabs = classifyTabs(records, await d.heldTabs(), d.self?.id);
  // A tab that appeared since we started could use anything: stop and let the next run decide.
  if (tabs.unknown.length > 0) return { removed: [], failed: 0, stop: true };
  const freshlyUsed = liveHashes(tabs.live);
  const seen = new Map<string, number>();
  for (const [key, value] of await d.kv.getMany(batch.map((b) => seenKey(b.hash)))) {
    if (isNumber(value)) seen.set(key.slice(SEEN_PREFIX.length), value);
  }
  const again = planCollection({ blobs: batch, referenced: freshlyUsed, lastSeen: seen, now: now() });
  // The marks and the autosave/library sources were checked by the plan; only newer use matters here.
  const removed: BlobStat[] = [];
  let failed = 0;
  for (const blob of again.remove) {
    try {
      await d.blobs.deleteBlob(blob.hash);
      removed.push(blob);
    } catch (e) {
      failed++;
      const reason = e instanceof Error ? e.message : String(e);
      log(`Storage cleanup: could not remove ${blob.hash.slice(0, SHORT_HASH_LENGTH)}: ${reason}`);
    }
  }
  if (removed.length) await forgetRemovedBlobs(d, removed);
  return { removed, failed, stop: false };
}

/** Removed blobs' "last seen" marks and cached analyses go with them. */
async function forgetRemovedBlobs(d: CollectorDeps, removed: readonly BlobStat[]): Promise<void> {
  const hashes = new Set(removed.map((b) => b.hash));
  const analyses = await d.kv.keys((k) => isAnalysisKey(k) && hashes.has(k.slice(k.lastIndexOf(':') + 1)));
  await d.kv.del([...removed.map((b) => seenKey(b.hash)), ...analyses]).catch(() => {});
}
