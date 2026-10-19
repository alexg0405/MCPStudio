/** Small number helpers shared by the voice analysis steps. */

/** The logistic curve: 0.5 at zero, 0 and 1 far to either side. Turns a hard threshold into a soft score. */
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export const dbToAmp = (db: number): number => Math.pow(10, db / 20);

/** Amplitude to dB, floored so that silence is −240 dB rather than −Infinity. */
export const ampToDb = (amp: number): number => 20 * Math.log10(Math.max(amp, 1e-12));

/** The median of the values (the mean of the middle two for an even count); NaN for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length & 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
