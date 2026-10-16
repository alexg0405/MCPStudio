/**
 * What each open tab publishes so a clean-up in any tab can tell which audio is still in use. A tab's
 * record lists every hash its project, its undo and redo history and its running operations mention.
 * A record only counts while the tab's life lock is held; the records of tabs that died are not trusted
 * (their hashes are marked "seen" at their last heartbeat, and the grace period does the rest).
 */

export interface TabRecord {
  v: 1;
  /** The tab's session id (also the suffix of its life lock). */
  id: string;
  /** Hashes in use (lowercase). */
  hashes: string[];
  /** Date.now() of the last publish or heartbeat. */
  heartbeat: number;
  /** Audio is playing in this tab. */
  playing: boolean;
  /** An export, render or import is running in this tab. */
  busy: boolean;
}

export const TAB_RECORD_VERSION = 1;

export function isTabRecord(x: unknown): x is TabRecord {
  const r = x as Partial<TabRecord> | null;
  return (
    !!r &&
    r.v === TAB_RECORD_VERSION &&
    typeof r.id === 'string' &&
    Array.isArray(r.hashes) &&
    r.hashes.every((h) => typeof h === 'string') &&
    typeof r.heartbeat === 'number' &&
    typeof r.playing === 'boolean' &&
    typeof r.busy === 'boolean'
  );
}

export interface TabClassification {
  /** Records of tabs whose life lock is held. */
  live: TabRecord[];
  /** Records of tabs that are gone. */
  dead: TabRecord[];
  /** Tabs whose life lock is held but that published nothing readable (starting up, or an older build). */
  unknown: string[];
}

/**
 * Splits records by whether the tab's lock is held. `self` is this tab: its record is always live,
 * and it is never "unknown".
 */
export function classifyTabs(
  records: readonly TabRecord[],
  heldIds: ReadonlySet<string>,
  self?: string,
): TabClassification {
  const live: TabRecord[] = [];
  const dead: TabRecord[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    seen.add(r.id);
    (heldIds.has(r.id) || r.id === self ? live : dead).push(r);
  }
  const unknown = [...heldIds].filter((id) => id !== self && !seen.has(id));
  return { live, dead, unknown };
}

export type Readiness = { ok: true } | { ok: false; reason: 'tab-starting' | 'busy' | 'playing' };

/**
 * Whether a clean-up may run now. A tab we know nothing about could be using anything, so it stops the
 * run. `idle` (the automatic one) also waits for playback; any run waits for an export or import.
 */
export function readiness(c: TabClassification, opts: { idle: boolean }): Readiness {
  if (c.unknown.length > 0) return { ok: false, reason: 'tab-starting' };
  if (c.live.some((t) => t.busy)) return { ok: false, reason: 'busy' };
  if (opts.idle && c.live.some((t) => t.playing)) return { ok: false, reason: 'playing' };
  return { ok: true };
}

/** The union of the hashes of live records. */
export function liveHashes(live: readonly TabRecord[]): Set<string> {
  const out = new Set<string>();
  for (const t of live) for (const h of t.hashes) out.add(h);
  return out;
}
