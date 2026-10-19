// The EQ Pro graph's geometry: how frequencies and gains map to pixels, and its fixed numbers.

/** One colour per band (handles, tabs, the selected band's fill): the theme's palette. */
export const BAND_COLORS = Array.from({ length: 8 }, (_, i) => `var(--ag-palette-${i + 1})`);
/** The graph's frequency axis runs from here to here, in Hz, on a log scale. */
export const MIN_FREQ_HZ = 20;
export const MAX_FREQ_HZ = 20000;
/** The curve's vertical range: ±24 dB (the gain range). */
export const DB_RANGE = 24;
/** The spectrum's range: 0 dBFS at the top, this at the bottom. */
export const SPECTRUM_FLOOR_DB = -96;
/** Space kept above and below the ±DB_RANGE span, in pixels. */
export const MARGIN = 10;
export const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
export const GRID_DB = [-18, -12, -6, 6, 12, 18];
/** How much one scroll tick on a handle changes its Q (a multiplier), and with Shift held. */
export const Q_STEP = 1.12;
export const FINE_Q_STEP = 1.03;
/** Bands a double-click on empty space may switch on, bells first. */
export const FREE_BAND_ORDER = [3, 4, 5, 6, 2, 7, 1, 8];

/** Limits `value` to [low, high]. */
export const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);

/** Where a frequency sits along the axis: 0 at the lowest, 1 at the highest. */
export const positionOfFrequency = (frequencyHz: number) =>
  Math.log(frequencyHz / MIN_FREQ_HZ) / Math.log(MAX_FREQ_HZ / MIN_FREQ_HZ);

/** The frequency at a position along the axis (0–1, clamped). */
export const frequencyAtPosition = (position: number) =>
  MIN_FREQ_HZ * Math.pow(MAX_FREQ_HZ / MIN_FREQ_HZ, clamp(position, 0, 1));

/** The y pixel of a gain in dB, in a graph `height` pixels tall (0 dB in the middle). */
export const yOfDb = (db: number, height: number) => height / 2 - (db / DB_RANGE) * (height / 2 - MARGIN);

/** The gain in dB at a y pixel: the inverse of `yOfDb`. */
export const dbAtY = (y: number, height: number) => ((height / 2 - y) / (height / 2 - MARGIN)) * DB_RANGE;
