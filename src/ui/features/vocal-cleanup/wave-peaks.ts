/** A recording's outline for the Clean up vocal window's strip: the highest and lowest sample in each of a fixed number of columns. */

/** Columns of the outline (the strip draws them stretched or squeezed to its width). */
export const PEAK_COLUMNS = 1600;

/** The outline of a sound: `columns` pairs of (lowest, highest) sample over all channels, left to right. */
export function peakColumns(channels: readonly Float32Array[], columns = PEAK_COLUMNS): Float32Array {
  const out = new Float32Array(columns * 2);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return out;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor((c * length) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * length) / columns));
    let low = 0;
    let high = 0;
    for (const channel of channels) {
      for (let i = from; i < to && i < length; i++) {
        const v = channel[i] as number;
        if (v < low) low = v;
        if (v > high) high = v;
      }
    }
    out[c * 2] = low;
    out[c * 2 + 1] = high;
  }
  return out;
}

/** The breath marker (index into `spans`) under second `t`, or -1; markers are padded to at least `minWidthSec` so a short one can be hit. */
export function markerAt(spans: readonly { from: number; to: number }[], t: number, minWidthSec: number): number {
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as { from: number; to: number };
    const pad = Math.max(0, (minWidthSec - (span.to - span.from)) / 2);
    if (t >= span.from - pad && t <= span.to + pad) return i;
  }
  return -1;
}
