import { describe, expect, it } from 'vitest';
import { clockTime, dayHeading, formatAgo, localDay } from './time';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-20T15:30:00Z');

describe('formatAgo', () => {
  it('reads in the unit a person would use', () => {
    expect(formatAgo(NOW - 3_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 45_000, NOW)).toBe('45 s ago');
    expect(formatAgo(NOW - 3 * MINUTE, NOW)).toBe('3 min ago');
    expect(formatAgo(NOW - 5 * HOUR, NOW)).toBe('5 h ago');
    expect(formatAgo(NOW - DAY, NOW)).toBe('1 day ago');
    expect(formatAgo(NOW - 5 * DAY, NOW)).toBe('5 days ago');
    expect(formatAgo(NOW - 21 * DAY, NOW)).toBe('3 weeks ago');
    expect(formatAgo(NOW - 120 * DAY, NOW)).toBe('4 months ago');
  });

  it('treats a time in the future as just now', () => {
    expect(formatAgo(NOW + HOUR, NOW)).toBe('just now');
  });
});

describe('dayHeading', () => {
  it('says Today and Yesterday by calendar day where the musician lives', () => {
    // 23:30 UTC the day before is already "today" at UTC+2 (01:30), and still "yesterday" at UTC.
    const lateLastNight = Date.parse('2026-10-19T23:30:00Z');
    expect(dayHeading(lateLastNight, NOW, 0)).toBe('Yesterday');
    expect(dayHeading(lateLastNight, NOW, 120)).toBe('Today');
    expect(dayHeading(NOW - 2 * HOUR, NOW, 0)).toBe('Today');
  });

  it('names an older day by its date', () => {
    expect(dayHeading(Date.parse('2026-10-12T10:00:00Z'), NOW, 0, 'en-GB')).toBe('Mon 12 Oct');
  });
});

describe('clockTime and localDay', () => {
  it('shows the local clock time', () => {
    expect(clockTime(Date.parse('2026-10-20T14:05:00Z'), 0, 'en-GB')).toBe('14:05');
    expect(clockTime(Date.parse('2026-10-20T14:05:00Z'), 120, 'en-GB')).toBe('16:05');
  });

  it('counts local days', () => {
    expect(localDay(Date.parse('2026-10-20T23:30:00Z'), 0)).toBe(localDay(Date.parse('2026-10-20T01:00:00Z'), 0));
    expect(localDay(Date.parse('2026-10-20T23:30:00Z'), 60)).toBe(localDay(Date.parse('2026-10-20T01:00:00Z'), 0) + 1);
  });
});
