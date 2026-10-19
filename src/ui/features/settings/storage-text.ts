/** The words of the Storage settings: sizes, hints and the last cleanup, in plain English (pure). */
import type { StorageStatus, StorageUsage } from '@app/storage/service';
import { formatSize, plural } from '@core/gc/format';

/** How many files and bytes a row of the table counts. */
type Amount = { files: number; bytes: number };

/** Plain words for one row of the table: "12.5 MB in 3 files". */
export function amountText(amount: Amount, one: string, many?: string): string {
  return amount.files === 0 ? 'Nothing' : `${formatSize(amount.bytes)} in ${plural(amount.files, one, many)}`;
}

/** The "Other" row: autosaves and audio nothing uses any more. */
export function otherText(other: StorageUsage['other']): string {
  if (other.bytes === 0) return 'Nothing';
  return `${formatSize(other.bytes)} (${formatSize(other.autosaveBytes)} autosaves, ${formatSize(other.unusedBytes)} unused audio)`;
}

/** What the Unused audio row says: what can go now, what waits out its first week, or that everything is in use. */
export function unusedAudioHint(removable: Amount, waiting: Amount): string {
  const waitingNote =
    waiting.files > 0 ? ` ${plural(waiting.files, 'more file')} (${formatSize(waiting.bytes)}) waits out its first week.` : '';
  if (removable.files > 0) {
    const it = removable.files === 1 ? 'it' : 'them';
    const has = removable.files === 1 ? 'it has' : 'they have';
    return `${plural(removable.files, 'file')} (${formatSize(removable.bytes)}) can go now: nothing uses ${it} and ${has} sat unused for over a week.${waitingNote}`;
  }
  if (waiting.files > 0) {
    const it = waiting.files === 1 ? 'it' : 'them';
    return `${plural(waiting.files, 'file')} (${formatSize(waiting.bytes)}) isn’t used by anything, but stays for a week in case you need ${it} back.`;
  }
  return 'All the audio stored here is in use.';
}

/** What the Automatic row says about the idle-time cleanup (a development build only reports what it would do). */
export function automaticCleanupHint(isDryRunOnly: boolean): string {
  const base =
    'When AGstudio is idle (never while playing or exporting), audio that nothing uses is removed a week after it was last used. ' +
    'Projects you saved to a file keep their own copy of their audio, so they open fine either way.';
  return isDryRunOnly ? `${base} This development build only writes to the console what it would remove.` : base;
}

/** The Last cleanup row: when, and what was (or would have been) removed. */
export function lastRunText(lastRun: NonNullable<StorageStatus['lastRun']>): string {
  const when = new Date(lastRun.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const what = `${plural(lastRun.removed, 'file')} (${formatSize(lastRun.bytes)})`;
  return `${when}: ${lastRun.dryRun ? 'would have removed' : 'removed'} ${what}`;
}
