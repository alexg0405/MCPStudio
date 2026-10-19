import { butterworth } from '../filters';

/** The low band covers everything under this (Hz). */
export const LOW_BAND_HZ = 300;
/** The high band covers everything over this (Hz). */
export const HIGH_BAND_HZ = 3000;

/** Index of each band in the arrays the envelope code passes around. */
export const FULL_BAND = 0;
/** Index of the low band (under `LOW_BAND_HZ`). */
export const LOW_BAND = 1;
/** Index of the high band (over `HIGH_BAND_HZ`). */
export const HIGH_BAND = 2;
/** How many bands there are: full, low and high. */
export const BAND_COUNT = 3;

/** Filter state smaller than this is flushed to zero: denormal floats make the filter loop slow. */
const DENORMAL_LIMIT = 1e-30;

/**
 * Prefix sums (length blocks + 1) of the energy per block in the full band, below 300 Hz and
 * above 3 kHz, in one pass (the two filters are streamed; nothing is copied). Any RMS window over
 * whole blocks is then two reads and a subtraction. Order: full, low, high.
 */
export function bandEnergyPrefixSums(
  x: Float32Array,
  block: number,
  blocks: number,
  sampleRate: number,
): Float64Array[] {
  const n = x.length;
  const full = new Float64Array(blocks + 1);
  const low = new Float64Array(blocks + 1);
  const high = new Float64Array(blocks + 1);
  const lp = butterworth('lowpass', 2, LOW_BAND_HZ, sampleRate);
  const hp = butterworth('highpass', 2, HIGH_BAND_HZ, sampleRate);
  const l0 = lp[0] as number;
  const l1 = lp[1] as number;
  const l2 = lp[2] as number;
  const l3 = lp[3] as number;
  const l4 = lp[4] as number;
  const h0 = hp[0] as number;
  const h1 = hp[1] as number;
  const h2 = hp[2] as number;
  const h3 = hp[3] as number;
  const h4 = hp[4] as number;
  let lz1 = 0;
  let lz2 = 0;
  let hz1 = 0;
  let hz2 = 0;
  for (let j = 0; j < blocks; j++) {
    let fullEnergy = 0;
    let lowEnergy = 0;
    let highEnergy = 0;
    const end = Math.min(n, (j + 1) * block);
    for (let i = j * block; i < end; i++) {
      const v = x[i] as number;
      fullEnergy += v * v;
      const yl = l0 * v + lz1;
      lz1 = l1 * v - l3 * yl + lz2;
      lz2 = l2 * v - l4 * yl;
      lowEnergy += yl * yl;
      const yh = h0 * v + hz1;
      hz1 = h1 * v - h3 * yh + hz2;
      hz2 = h2 * v - h4 * yh;
      highEnergy += yh * yh;
    }
    // Flush denormals (digital silence after a sound) once per block.
    if (Math.abs(lz1) < DENORMAL_LIMIT) lz1 = 0;
    if (Math.abs(lz2) < DENORMAL_LIMIT) lz2 = 0;
    if (Math.abs(hz1) < DENORMAL_LIMIT) hz1 = 0;
    if (Math.abs(hz2) < DENORMAL_LIMIT) hz2 = 0;
    full[j + 1] = (full[j] as number) + fullEnergy;
    low[j + 1] = (low[j] as number) + lowEnergy;
    high[j + 1] = (high[j] as number) + highEnergy;
  }
  return [full, low, high];
}
