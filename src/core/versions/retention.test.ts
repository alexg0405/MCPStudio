import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, planRetention, type RetentionInput } from './retention';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-20T15:30:00Z');

const at = (ageMs: number, id: string, pinned = false): RetentionInput => ({ id, createdAt: NOW - ageMs, pinned });

describe('planRetention', () => {
  it('keeps every version from the last day', () => {
    const versions = [at(1 * HOUR, 'a'), at(1 * HOUR + 60_000, 'b'), at(5 * HOUR, 'c'), at(23 * HOUR, 'd')];
    expect(planRetention(versions, NOW)).toEqual([]);
  });

  it('keeps one version per hour, the newest, between a day and a week old', () => {
    // Three versions inside the same clock hour two days ago: the newest stays.
    const hourStart = Math.floor((NOW - 2 * DAY) / HOUR) * HOUR;
    const versions: RetentionInput[] = [
      { id: 'late', createdAt: hourStart + 50 * 60_000, pinned: false },
      { id: 'mid', createdAt: hourStart + 30 * 60_000, pinned: false },
      { id: 'early', createdAt: hourStart + 5 * 60_000, pinned: false },
      { id: 'next-hour', createdAt: hourStart + HOUR + 10 * 60_000, pinned: false },
    ];
    expect(planRetention(versions, NOW)).toEqual(['mid', 'early']);
  });

  it('keeps one version per day, the newest, between a week and a month old', () => {
    const dayStart = Math.floor((NOW - 10 * DAY) / DAY) * DAY;
    const versions: RetentionInput[] = [
      { id: 'evening', createdAt: dayStart + 20 * HOUR, pinned: false },
      { id: 'noon', createdAt: dayStart + 12 * HOUR, pinned: false },
      { id: 'morning', createdAt: dayStart + 8 * HOUR, pinned: false },
      { id: 'other-day', createdAt: dayStart - 5 * HOUR, pinned: false },
    ];
    expect(planRetention(versions, NOW)).toEqual(['noon', 'morning']);
  });

  it('removes what is older than a month', () => {
    const versions = [at(40 * DAY, 'old'), at(31 * DAY, 'older'), at(29 * DAY, 'fresh-enough'), at(2 * HOUR, 'new')];
    expect(planRetention(versions, NOW)).toEqual(['older', 'old']);
  });

  it('never removes a pinned version, however old', () => {
    const versions = [at(400 * DAY, 'forever', true), at(40 * DAY, 'old'), at(1 * HOUR, 'new')];
    expect(planRetention(versions, NOW)).toEqual(['old']);
  });

  it('always keeps the newest version, even when it is old, so a project is never left with none', () => {
    expect(planRetention([at(90 * DAY, 'only')], NOW)).toEqual([]);
    expect(planRetention([at(90 * DAY, 'a'), at(100 * DAY, 'b')], NOW)).toEqual(['b']);
  });

  it('counts calendar days where the musician lives', () => {
    // 23:30 and 00:30 UTC are one local day at UTC-5 (18:30 and 19:30 of the same day) and two days at UTC.
    const midnight = Math.floor((NOW - 10 * DAY) / DAY) * DAY;
    const versions: RetentionInput[] = [
      { id: 'after-midnight', createdAt: midnight + 30 * 60_000, pinned: false },
      { id: 'before-midnight', createdAt: midnight - 30 * 60_000, pinned: false },
    ];
    expect(planRetention(versions, NOW, DEFAULT_RETENTION, 0)).toEqual([]);
    expect(planRetention(versions, NOW, DEFAULT_RETENTION, -5 * 60)).toEqual(['before-midnight']);
  });

  it('caps the versions that are not pinned, oldest first, without touching pinned ones', () => {
    const versions: RetentionInput[] = [];
    for (let i = 0; i < 10; i++) versions.push(at(i * 60_000, `v${i}`));
    versions.push(at(5 * 60_000, 'pinned', true));
    const plan = planRetention(versions, NOW, { ...DEFAULT_RETENTION, maxUnpinned: 4 });
    expect(plan).toEqual(['v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
    expect(plan).not.toContain('pinned');
  });

  it('treats a version from the future as new', () => {
    expect(planRetention([{ id: 'future', createdAt: NOW + 10 * DAY, pinned: false }, at(3 * HOUR, 'a')], NOW)).toEqual([]);
  });

  it('is the same however the list is ordered', () => {
    const versions = [at(2 * DAY, 'a'), at(2 * DAY + 60_000, 'b'), at(10 * DAY, 'c'), at(10 * DAY + 5 * HOUR, 'd'), at(50 * DAY, 'e')];
    const forward = planRetention(versions, NOW);
    expect(planRetention([...versions].reverse(), NOW)).toEqual(forward);
  });
});
