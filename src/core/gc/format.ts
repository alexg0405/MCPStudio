/** Sizes in plain words: "0 KB", "340 KB", "12.5 MB", "1.3 GB" (powers of 1024, one decimal from MB up). */
export function formatSize(bytes: number): string {
  const b = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 100 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * A count with its noun in plain words: "1 file", "3 files" (give the plural form when it is not the singular plus
 * "s").
 */
export const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
