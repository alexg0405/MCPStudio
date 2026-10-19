/** Text for the export dialog: times and file sizes the way a person reads them (pure). */

/** A length in seconds as "m:ss" ("0:07", "3:25"). */
export function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secondsPart = Math.round(seconds % 60);
  return `${minutes}:${String(secondsPart).padStart(2, '0')}`;
}

/** A file size in bytes as "41 MB" or "1.2 GB" (never less than 1 MB). */
export function megabytes(bytes: number): string {
  const BYTES_PER_GB = 1e9;
  const BYTES_PER_MB = 1e6;
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / BYTES_PER_MB))} MB`;
}
