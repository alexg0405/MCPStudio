/** Small pure helpers for the sample browser window's filters and selection. */
import type { SampleFilter } from '@core/samples/query';

/** The list without `value` when it is in it, with it added when it is not (a toggle button's new list). */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/** The top of a tempo range with no upper limit typed (BPM): above every real loop. */
const OPEN_ENDED_HIGH_BPM = 999;

/** The tempo range filter for what is typed in the two tempo boxes (an empty box is open-ended), or null for no filter. */
export function bpmFilterFor(lowText: string, highText: string): SampleFilter['bpm'] {
  if (lowText === '' && highText === '') return null;
  const low = Number(lowText);
  const high = Number(highText);
  return [lowText !== '' && low > 0 ? low : 0, highText !== '' && high > 0 ? high : OPEN_ENDED_HIGH_BPM];
}

/** True when anything narrows the list: a search word, any chip, a folder, or the song-key switch. */
export function hasActiveFilter(filter: SampleFilter, isInSongKey: boolean): boolean {
  return (
    filter.text !== '' ||
    filter.categories.length > 0 ||
    filter.kind !== 'any' ||
    filter.bpm !== null ||
    filter.keys.length > 0 ||
    filter.favorites ||
    filter.recent ||
    filter.tags.length > 0 ||
    filter.under !== null ||
    isInSongKey
  );
}

/** The ids of the rows from index `a` to index `b` (either order), both included: a shift-click or shift-arrow range. */
export function idsBetween(rows: readonly { id: string }[], a: number, b: number): string[] {
  const [from, to] = a < b ? [a, b] : [b, a];
  return rows.slice(from, to + 1).map((r) => r.id);
}
