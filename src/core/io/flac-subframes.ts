/**
 * Choosing how to code one channel of one block (RFC 9639 §9.2): CONSTANT, VERBATIM, FIXED predictors of
 * order 0–4, or LPC with quantized coefficients. Planning estimates the size of every candidate and keeps the
 * smallest; the winning plan writes itself later (its residual is recomputed then, so no copies are kept).
 *
 * The residual loops here run for every sample of the export: no allocation inside them.
 */
import type { BitWriter } from './flac-bits';
import {
  SUBFRAME_TYPE_CONSTANT,
  SUBFRAME_TYPE_FIXED_BASE,
  SUBFRAME_TYPE_LPC_BASE,
  SUBFRAME_TYPE_VERBATIM,
  subframeHeaderByte,
} from './flac-format';
import { planRice, writeRice, type RicePlan } from './flac-rice';

/** The highest FIXED predictor order the format has. */
const MAX_FIXED_ORDER = 4;
/** Blocks this short are not worth an LPC attempt. */
const MIN_BLOCK_FOR_LPC = 32;
/** The subframe header byte: padding bit, 6-bit type, wasted-bits flag. */
const SUBFRAME_HEADER_BITS = 8;
/** LPC header after the warm-up samples: 4 bits of precision − 1, 5 bits of shift (§9.2.5). */
const LPC_PRECISION_FIELD_BITS = 4;
const LPC_SHIFT_FIELD_BITS = 5;
/** Quantized coefficient precision in bits (the format allows 1–15): 14 for 16-bit audio, 15 beyond. */
const LPC_PRECISION_16_BIT = 14;
const LPC_PRECISION_24_BIT = 15;
/** The largest right shift the format can express for LPC coefficients (the shift field is signed 5-bit). */
const LPC_SHIFT_MAX = 15;
/** The residual must fit in 31 bits (the format's limit for the decoder's arithmetic). */
const RESIDUAL_LIMIT = 2 ** 30;
/** The window taper is Tukey(0.5): a cosine ramp over a quarter of the block at each end. */
const TUKEY_TAPER_FRACTION = 0.5;
/** Added to the zero-lag autocorrelation so Levinson–Durbin stays stable on near-silent blocks. */
const AUTOCORRELATION_NOISE_FLOOR = 1e-10;

/** Scratch buffers reused across frames, so encoding does not allocate per block. */
export class Workspace {
  readonly mid: Int32Array;
  readonly side: Int32Array;
  readonly residual: Int32Array;
  readonly windowed: Float64Array;
  private tukey: Float64Array | null = null;

  constructor(blockSize: number) {
    this.mid = new Int32Array(blockSize);
    this.side = new Int32Array(blockSize);
    this.residual = new Int32Array(blockSize);
    this.windowed = new Float64Array(blockSize);
  }

  /** Tukey(0.5) window for a block of `length` samples (cached: nearly every block has the same size). */
  window(length: number): Float64Array {
    if (this.tukey?.length !== length) this.tukey = makeTukeyWindow(length);
    return this.tukey;
  }
}

function makeTukeyWindow(length: number): Float64Array {
  const window = new Float64Array(length);
  const taper = Math.floor((TUKEY_TAPER_FRACTION * length) / 2);
  for (let i = 0; i < length; i++) {
    let value = 1;
    if (i < taper) value = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    else if (i >= length - taper) value = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / taper);
    window[i] = value;
  }
  return window;
}

/** One candidate way to code a channel of a block. */
export interface SubframePlan {
  /** The samples. */
  samples: Int32Array;
  /** Bits per sample (a side channel has one more than the audio). */
  bitsPerSample: number;
  /** Estimated size in bits. */
  bits: number;
  /** Writes the subframe; residuals are recomputed here (planning keeps no copies). */
  write(writer: BitWriter, work: Workspace): void;
}

/** The smallest of CONSTANT, VERBATIM and FIXED orders 0–4. */
export function planFixed(samples: Int32Array, bitsPerSample: number, work: Workspace): SubframePlan {
  const length = samples.length;
  if (isConstant(samples)) return constantPlan(samples, bitsPerSample);

  let best = verbatimPlan(samples, bitsPerSample);
  const residual = work.residual.subarray(0, length);
  for (let order = 0; order <= Math.min(MAX_FIXED_ORDER, length - 1); order++) {
    fixedResidual(samples, order, residual);
    const rice = planRice(residual, order, length);
    const bits = SUBFRAME_HEADER_BITS + order * bitsPerSample + rice.bits;
    if (bits < best.bits) best = fixedPlan(samples, bitsPerSample, order, bits, rice);
  }
  return best;
}

function isConstant(samples: Int32Array): boolean {
  const first = samples[0] as number;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] !== first) return false;
  }
  return true;
}

function constantPlan(samples: Int32Array, bitsPerSample: number): SubframePlan {
  const value = samples[0] as number;
  return {
    samples,
    bitsPerSample,
    bits: SUBFRAME_HEADER_BITS + bitsPerSample,
    write: (writer) => {
      writer.write(subframeHeaderByte(SUBFRAME_TYPE_CONSTANT), 8);
      writer.writeSigned(value, bitsPerSample);
    },
  };
}

function verbatimPlan(samples: Int32Array, bitsPerSample: number): SubframePlan {
  const length = samples.length;
  return {
    samples,
    bitsPerSample,
    bits: SUBFRAME_HEADER_BITS + length * bitsPerSample,
    write: (writer) => {
      writer.write(subframeHeaderByte(SUBFRAME_TYPE_VERBATIM), 8);
      for (let i = 0; i < length; i++) writer.writeSigned(samples[i] as number, bitsPerSample);
    },
  };
}

function fixedPlan(
  samples: Int32Array,
  bitsPerSample: number,
  order: number,
  bits: number,
  rice: RicePlan,
): SubframePlan {
  const length = samples.length;
  return {
    samples,
    bitsPerSample,
    bits,
    write: (writer, work) => {
      writer.write(subframeHeaderByte(SUBFRAME_TYPE_FIXED_BASE + order), 8);
      for (let i = 0; i < order; i++) writer.writeSigned(samples[i] as number, bitsPerSample);
      const residual = work.residual.subarray(0, length);
      fixedResidual(samples, order, residual);
      writeRice(writer, residual.subarray(order), rice, order);
    },
  };
}

/** Tries LPC on a channel and keeps it when it beats the fixed plan. */
export function refineLpc(fixed: SubframePlan, maxLpcOrder: number, work: Workspace): SubframePlan {
  const length = fixed.samples.length;
  const constantBits = SUBFRAME_HEADER_BITS + fixed.bitsPerSample;
  if (maxLpcOrder <= 0 || length <= MIN_BLOCK_FOR_LPC || fixed.bits <= constantBits) return fixed;
  const lpc = planLpc(fixed.samples, fixed.bitsPerSample, Math.min(maxLpcOrder, length - 1), work);
  return lpc && lpc.bits < fixed.bits ? lpc : fixed;
}

/**
 * The FIXED predictors (§9.2.4) are polynomial extrapolations: order 0 is the signal, order 1 the
 * difference, and so on, with the binomial coefficients 1, −2, 1 / 1, −3, 3, −1 / 1, −4, 6, −4, 1.
 */
function fixedResidual(x: Int32Array, order: number, out: Int32Array): void {
  const n = x.length;
  for (let i = 0; i < order; i++) out[i] = 0;
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i] as number;
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i] = (x[i] as number) - (x[i - 1] as number);
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i] = (x[i] as number) - 2 * (x[i - 1] as number) + (x[i - 2] as number);
      break;
    case 3:
      for (let i = 3; i < n; i++)
        out[i] = (x[i] as number) - 3 * (x[i - 1] as number) + 3 * (x[i - 2] as number) - (x[i - 3] as number);
      break;
    case 4:
      for (let i = 4; i < n; i++)
        out[i] =
          (x[i] as number) -
          4 * (x[i - 1] as number) +
          6 * (x[i - 2] as number) -
          4 * (x[i - 3] as number) +
          (x[i - 4] as number);
      break;
  }
}

/** Quantized LPC coefficients: each is `coefs[j] / 2^shift`. */
interface QuantizedCoefficients {
  coefs: Int32Array;
  shift: number;
}

/** LPC with the order the prediction error favours (coefficients quantized like libFLAC). */
function planLpc(x: Int32Array, bitsPerSample: number, maxOrder: number, work: Workspace): SubframePlan | null {
  const length = x.length;
  const autocorrelation = windowedAutocorrelation(x, maxOrder, work);
  if (!(autocorrelation[0]! > 0)) return null;
  autocorrelation[0] = autocorrelation[0]! * (1 + AUTOCORRELATION_NOISE_FLOOR);
  const { coefs, errors } = levinsonDurbin(autocorrelation, maxOrder);
  if (coefs.length === 0) return null;

  const precision = bitsPerSample <= 16 ? LPC_PRECISION_16_BIT : LPC_PRECISION_24_BIT;
  const order = cheapestOrder(errors, length, bitsPerSample, precision);
  const quantized = quantizeCoefficients(coefs[order - 1]!, precision);
  if (!quantized) return null;
  const residual = work.residual.subarray(0, length);
  if (!lpcResidual(x, order, quantized, residual)) return null;

  const rice = planRice(residual, order, length);
  const headerBits = SUBFRAME_HEADER_BITS + LPC_PRECISION_FIELD_BITS + LPC_SHIFT_FIELD_BITS;
  const bits = headerBits + order * bitsPerSample + order * precision + rice.bits;
  return {
    samples: x,
    bitsPerSample,
    bits,
    write: (writer, ws) => {
      writer.write(subframeHeaderByte(SUBFRAME_TYPE_LPC_BASE + order - 1), 8);
      for (let i = 0; i < order; i++) writer.writeSigned(x[i] as number, bitsPerSample);
      writer.write(precision - 1, LPC_PRECISION_FIELD_BITS);
      writer.writeSigned(quantized.shift, LPC_SHIFT_FIELD_BITS);
      for (let j = 0; j < order; j++) writer.writeSigned(quantized.coefs[j] as number, precision);
      const r = ws.residual.subarray(0, length);
      lpcResidual(x, order, quantized, r);
      writeRice(writer, r.subarray(order), rice, order);
    },
  };
}

/** Autocorrelation of the Tukey-windowed block for lags 0…maxOrder. */
function windowedAutocorrelation(x: Int32Array, maxOrder: number, work: Workspace): Float64Array {
  const length = x.length;
  const tukey = work.window(length);
  const windowed = work.windowed;
  for (let i = 0; i < length; i++) windowed[i] = (x[i] as number) * (tukey[i] as number);
  const autocorrelation = new Float64Array(maxOrder + 1);
  for (let lag = 0; lag <= maxOrder; lag++) {
    let sum = 0;
    for (let i = lag; i < length; i++) sum += (windowed[i] as number) * (windowed[i - lag] as number);
    autocorrelation[lag] = sum;
  }
  return autocorrelation;
}

/**
 * Levinson–Durbin recursion: the predictor coefficients and the remaining prediction error for every
 * order 1…maxOrder (stopping early when the error stops being positive).
 */
function levinsonDurbin(r: Float64Array, maxOrder: number): { coefs: Float64Array[]; errors: number[] } {
  const coefs: Float64Array[] = [];
  const errors: number[] = [];
  let a = new Float64Array(0);
  let error = r[0]!;
  for (let m = 1; m <= maxOrder; m++) {
    let acc = r[m]!;
    for (let j = 0; j < m - 1; j++) acc -= a[j]! * r[m - 1 - j]!;
    const reflection = acc / error;
    const next = new Float64Array(m);
    for (let j = 0; j < m - 1; j++) next[j] = a[j]! - reflection * a[m - 2 - j]!;
    next[m - 1] = reflection;
    a = next;
    error *= 1 - reflection * reflection;
    if (!(error > 0)) break;
    coefs.push(a);
    errors.push(error);
  }
  return { coefs, errors };
}

/** The order with the fewest expected bits: residual bits from the error, plus warm-up and coefficients. */
function cheapestOrder(errors: number[], length: number, bitsPerSample: number, precision: number): number {
  let order = 1;
  let bestEstimate = Infinity;
  for (let m = 1; m <= errors.length; m++) {
    const meanSquareError = errors[m - 1]! / length;
    const bitsPerResidual = meanSquareError > 1 ? 0.5 * Math.log2(meanSquareError) + 0.5 : 0.5;
    const estimate = (length - m) * bitsPerResidual + m * (bitsPerSample + precision);
    if (estimate < bestEstimate) {
      bestEstimate = estimate;
      order = m;
    }
  }
  return order;
}

/**
 * x[i] − (Σ q·x[i−1−j]) >> shift for i ≥ order. False when a residual doesn't fit in 31 bits (the plan is
 * then dropped).
 */
function lpcResidual(x: Int32Array, order: number, q: QuantizedCoefficients, out: Int32Array): boolean {
  const n = x.length;
  const c = q.coefs;
  // Scaling by a power of two is exact in floating point, so floor(sum · 2^−shift) is sum >> shift.
  const inverseScale = 2 ** -q.shift;
  for (let i = 0; i < order; i++) out[i] = 0;
  for (let i = order; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += (c[j] as number) * (x[i - 1 - j] as number);
    const e = (x[i] as number) - Math.floor(sum * inverseScale);
    if (e >= RESIDUAL_LIMIT || e <= -RESIDUAL_LIMIT) return false;
    out[i] = e;
  }
  return true;
}

/**
 * Rounds the coefficients to `precision`-bit integers with a common shift, carrying each rounding error
 * into the next coefficient (as libFLAC does). Null when they cannot be expressed.
 */
function quantizeCoefficients(a: Float64Array, precision: number): QuantizedCoefficients | null {
  let largest = 0;
  for (const c of a) largest = Math.max(largest, Math.abs(c));
  if (!(largest > 0) || !Number.isFinite(largest)) return null;
  const log2Largest = Math.floor(Math.log2(largest)) + 1;
  let shift = precision - 1 - log2Largest;
  if (shift > LPC_SHIFT_MAX) shift = LPC_SHIFT_MAX;
  if (shift < 0) return null;
  const limit = 2 ** (precision - 1);
  const coefs = new Int32Array(a.length);
  let carry = 0;
  for (let j = 0; j < a.length; j++) {
    carry += a[j]! * 2 ** shift;
    let value = Math.round(carry);
    if (value > limit - 1) value = limit - 1;
    else if (value < -limit) value = -limit;
    carry -= value;
    coefs[j] = value;
  }
  return { coefs, shift };
}
