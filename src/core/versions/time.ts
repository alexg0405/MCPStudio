/**
 * Times in plain words for the lists of versions and projects: "just now", "3 min ago", "Yesterday". Pure (the clock and
 * the time zone come in as arguments), so what the lists say is a plain test.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "3 min ago", "2 h ago", "5 days ago", "3 weeks ago", "4 months ago". A time in the future reads "just now". */
export function formatAgo(thenMs: number, nowMs: number): string {
  const age = nowMs - thenMs;
  if (age < 10 * SECOND_MS) return 'just now';
  if (age < MINUTE_MS) return `${Math.round(age / SECOND_MS)} s ago`;
  if (age < HOUR_MS) return `${Math.round(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `${Math.round(age / HOUR_MS)} h ago`;
  const days = Math.round(age / DAY_MS);
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** The local calendar day of a time as a whole number (days since 1970 in the musician's time zone). */
export function localDay(timeMs: number, utcOffsetMinutes: number): number {
  return Math.floor((timeMs + utcOffsetMinutes * MINUTE_MS) / DAY_MS);
}

/**
 * The heading of a day in a timeline: "Today", "Yesterday", or the date ("Mon 12 Oct"). `utcOffsetMinutes` is the local
 * time zone (east positive).
 */
export function dayHeading(timeMs: number, nowMs: number, utcOffsetMinutes: number, locale?: string): string {
  const daysAgo = localDay(nowMs, utcOffsetMinutes) - localDay(timeMs, utcOffsetMinutes);
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  const shifted = new Date(timeMs + utcOffsetMinutes * MINUTE_MS);
  return shifted.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The clock time of a version ("14:05" or "2:05 PM", as the locale writes it). */
export function clockTime(timeMs: number, utcOffsetMinutes: number, locale?: string): string {
  const shifted = new Date(timeMs + utcOffsetMinutes * MINUTE_MS);
  return shifted.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}
