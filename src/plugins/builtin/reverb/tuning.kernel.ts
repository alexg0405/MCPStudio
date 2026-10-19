// The algorithmic reverb's tuning numbers and the first-order shelf math it is built from (see kernel.ts).

/** Delay lines in the feedback network. */
export const LINE_COUNT = 8;
/** Line lengths at Size 100 %, ms: spread over about 1.7 octaves, no two in a simple ratio. */
export const LINE_MS = [29.3, 34.1, 41.3, 47.9, 56.3, 66.7, 79.1, 93.7] as const;
export const LONGEST_LINE_MS = 93.7;
/** Size 0 % scales the lines by this (a small room). */
export const MIN_SIZE_SCALE = 0.45;
/** Each line's length drifts slowly (breaks up metallic ringing): the rates (Hz) of the drifts, and their depth (ms). */
export const DRIFT_RATES_HZ = [0.31, 0.83, 0.47, 1.07, 0.59, 0.37, 0.97, 0.71] as const;
export const DRIFT_DEPTH_MS = 0.5;
/** An allpass inside each line's loop (ms, gain): many more echoes and modes for the same lines. */
export const LOOP_ALLPASS_MS = [7.3, 5.9, 9.1, 4.7, 8.3, 6.7, 3.9, 10.3] as const;
export const LOOP_ALLPASS_GAIN = 0.5;
/** Input diffusion: four Schroeder allpasses a side (lengths in ms, left side then right side) and their gains. */
export const DIFFUSER_MS = [4.77, 3.59, 12.73, 9.3, 4.31, 3.97, 11.83, 10.13] as const;
export const DIFFUSER_GAINS = [0.75, 0.75, 0.625, 0.625] as const;
export const DIFFUSERS_PER_SIDE = 4;
/** Longest pre-delay (the param's max), seconds. */
export const MAX_PRE_DELAY_SEC = 0.2;
/** Line lengths, drift and coefficients are updated every CONTROL_FRAMES frames (delays ramp in between). */
export const CONTROL_FRAMES = 32;
/** Smoothing time constants of Decay/Damping and of Size, seconds. */
export const PARAM_SMOOTH_SEC = 0.05;
export const SIZE_SMOOTH_SEC = 0.1;
/** Fastest a line's length may glide, frames per frame (a Size change bends the tail's pitch, never clicks). */
export const MAX_GLIDE_STEP = 0.25;
/** Lines gliding faster than this (frames per frame) read with linear interpolation. */
export const LINEAR_READ_ABOVE_STEP = 0.01;
/**
 * Three decay bands, like the convolution engine's impulse response, set by two first-order shelves
 * per line: the lows (below LOW_BAND_HZ) ring LOW_BAND_RATIO times longer than Decay, the highs (above
 * HIGH_BAND_HZ) die in Decay · (1 − HIGH_BAND_DAMPING · Damping) and start at HIGH_BAND_LEVEL · (1 − 0.5 · Damping).
 * Tuned so each band's energy lands within about 2 dB of the convolution engine's at every Damping
 * (the shelves compound on every trip round, so the values differ from the IR generator's).
 */
export const LOW_BAND_HZ = 250;
export const HIGH_BAND_HZ = 8000;
export const LOW_BAND_RATIO = 1.2;
export const HIGH_BAND_DAMPING = 0.6;
export const HIGH_BAND_LEVEL = 0.85;
/** Frequencies sampled to estimate the tail's energy (for a loudness that doesn't depend on Decay). */
export const ENERGY_POINTS = 24;
/** Input below this (about −120 dBFS) is silence; a tail below TAIL_FLOOR (−100 dBFS) is over. */
export const SILENT_LEVEL = 1e-6;
export const TAIL_FLOOR = 1e-5;
/** Seconds of silence in and below-floor tail out before the network is cleared and goes idle. */
export const IDLE_GATE_SEC = 0.5;
/** Natural log of 1000: a fall of 60 dB is a factor of 1000 in amplitude. */
export const LN_1000 = Math.log(1000);

/**
 * Writes the feed-forward coefficients b0, b1 (at `at`, `at + 1`) of a first-order shelf with gain
 * `dc` at DC and `nyquist` at Nyquist, corner `omega` = tan(π·f/sr): the bilinear transform of
 * (nyquist·s + dc·Ω)/(s + Ω). Its feedback coefficient is (Ω − 1)/(Ω + 1).
 */
export function shelfInto(out: Float64Array, at: number, dc: number, nyquist: number, omega: number): void {
  out[at] = (nyquist + dc * omega) / (1 + omega);
  out[at + 1] = (dc * omega - nyquist) / (1 + omega);
}

/** |H(e^jω)|² of a first-order section (b0 + b1·z⁻¹)/(1 + a1·z⁻¹), given cos ω. */
export function shelfPower(b0: number, b1: number, a1: number, cos: number): number {
  return (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cos) / (1 + a1 * a1 + 2 * a1 * cos);
}

/** The smallest power of two that is at least `n` (and at least 4): a ring buffer size that wraps with a mask. */
export function powerOfTwoAtLeast(n: number): number {
  let size = 4;
  while (size < n) size <<= 1;
  return size;
}
