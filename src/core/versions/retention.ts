/**
 * How long versions are kept, as a pure plan: everything from the last day, one per hour for a week, one per day for a
 * month, and nothing older, except what the musician pinned (kept forever) and the newest version (a project always keeps
 * at least one). Which versions to delete is decided here; deleting them is `app/versions`.
 */

/** The thinning schedule. Times are in milliseconds. */
export interface RetentionPolicy {
  /** Every version younger than this is kept. */
  keepAllMs: number;
  /** Younger than this (and older than `keepAllMs`): the newest version of each hour stays. */
  hourlyMs: number;
  /** Younger than this (and older than `hourlyMs`): the newest version of each day stays. */
  dailyMs: number;
  /** A ceiling on the versions that are not pinned, whatever their age (the oldest go first). */
  maxUnpinned: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Keep all from the last day, hourly for a week, daily for a month, at most 400 that are not pinned. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  keepAllMs: DAY_MS,
  hourlyMs: 7 * DAY_MS,
  dailyMs: 30 * DAY_MS,
  maxUnpinned: 400,
};

/** What retention needs to know of a version. */
export interface RetentionInput {
  id: string;
  createdAt: number;
  pinned: boolean;
}

/**
 * The ids of the versions to delete, newest first. `utcOffsetMinutes` is the local time zone (east positive), so "one
 * per day" means calendar days where the musician lives. A version from the future (a clock set back) counts as new.
 */
export function planRetention(
  versions: readonly RetentionInput[],
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  utcOffsetMinutes = 0,
): string[] {
  const newestFirst = [...versions].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const newest = newestFirst[0];
  const offsetMs = utcOffsetMinutes * 60_000;
  const taken = new Set<string>();
  const doomed = new Set<string>();
  for (const version of newestFirst) {
    if (version.pinned) continue;
    const age = now - version.createdAt;
    if (age <= policy.keepAllMs) continue;
    if (age > policy.dailyMs) {
      if (version !== newest) doomed.add(version.id);
      continue;
    }
    const isHourly = age <= policy.hourlyMs;
    const slot = Math.floor((version.createdAt + offsetMs) / (isHourly ? HOUR_MS : DAY_MS));
    const bucket = `${isHourly ? 'h' : 'd'}${slot}`;
    // Newest first, so the first version seen in a slot is the one that stays.
    if (taken.has(bucket)) doomed.add(version.id);
    else taken.add(bucket);
  }
  const survivors = newestFirst.filter((v) => !v.pinned && !doomed.has(v.id));
  for (const version of survivors.slice(Math.max(0, policy.maxUnpinned))) {
    if (version !== newest) doomed.add(version.id);
  }
  return newestFirst.filter((v) => doomed.has(v.id)).map((v) => v.id);
}
