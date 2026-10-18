/** Analyser size for meters (about 43 ms at 48 kHz). */
export const METER_FRAMES = 2048;

/** Where meters read their analysers' samples (one per mixer), with an integer view of the same memory. */
export class MeterScratch {
  readonly samples = new Float32Array(METER_FRAMES);
  readonly bits = new Int32Array(this.samples.buffer);
}

/** Clears the sign bit of a float's bit pattern: the magnitude. */
const ABS_MASK = 0x7fffffff;
/** The bit pattern of +Infinity: a larger magnitude is a NaN. */
const INFINITY_BITS = 0x7f800000;
const peakBits = new Float32Array(1);
const peakAsInt = new Int32Array(peakBits.buffer);

/**
 * The largest |sample| of a buffer. The magnitudes of IEEE floats order like their bit patterns, so the
 * scan compares integers (about twice as fast as comparing floats); NaNs are ignored, as in a float scan.
 */
export function peakOf(scratch: MeterScratch): number {
  const bits = scratch.bits;
  // Four running maxima break the dependency between iterations, which the scan's speed depends on.
  let max0 = 0;
  let max1 = 0;
  let max2 = 0;
  let max3 = 0;
  for (let i = 0; i < bits.length; i += 4) {
    const a = (bits[i] as number) & ABS_MASK;
    const b = (bits[i + 1] as number) & ABS_MASK;
    const c = (bits[i + 2] as number) & ABS_MASK;
    const d = (bits[i + 3] as number) & ABS_MASK;
    if (a > max0) max0 = a;
    if (b > max1) max1 = b;
    if (c > max2) max2 = c;
    if (d > max3) max3 = d;
  }
  const largest = Math.max(max0, max1, max2, max3);
  if (largest <= INFINITY_BITS) {
    peakAsInt[0] = largest;
    return peakBits[0] as number;
  }
  return largestIgnoringNaN(scratch.samples);
}

/** A NaN is in the buffer (a plugin gone wrong): the largest magnitude of the rest. */
function largestIgnoringNaN(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] as number;
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}
