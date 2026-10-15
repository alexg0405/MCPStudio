/**
 * FLAC (Free Lossless Audio Codec) encoder, and a decoder for what it writes (round-trip tests and
 * verification). Pure TypeScript, no DOM; runs in Node, a Worker or the main thread.
 *
 * What the encoder writes (RFC 9639): a STREAMINFO block (with the MD5 of the audio), then frames of
 * 4096 samples. Each frame picks, per channel, the smallest of CONSTANT, VERBATIM, FIXED (orders
 * 0–4) and LPC (Levinson–Durbin on a Tukey-windowed block, order chosen from the prediction error,
 * quantized coefficients), with partitioned Rice-coded residuals; stereo frames also try
 * left/side, right/side and mid/side. Correctness first: every frame decodes bit-exactly to the
 * quantized input (the browser test checks it against Chrome's own decoder).
 */
import { Md5 } from './md5';
import { PcmQuantizer, quantizePcm } from './wav';

export type FlacBitDepth = 16 | 24;

export interface EncodeFlacOptions {
  bitDepth: FlacBitDepth;
  /** TPDF dither before quantizing (16-bit only), the same noise as the WAV encoder. */
  dither?: boolean;
  seed?: number;
  /** Samples per frame (16–65535, default 4096). */
  blockSize?: number;
  /** Highest LPC order tried (0 = fixed predictors only; default 8, at most 32). */
  maxLpcOrder?: number;
}

/** Encodes float audio (quantized exactly like encodeWav at the same depth, dither and seed). */
export function encodeFlac(channels: Float32Array[], sampleRate: number, opts: EncodeFlacOptions): Uint8Array {
  return encodeFlacPcm(quantizePcm(channels, opts.bitDepth, { dither: !!opts.dither, seed: opts.seed }), sampleRate, opts);
}

const BLOCK = 4096;

/** Encodes integer samples (one Int32Array per channel, within the bit depth's range). */
export function encodeFlacPcm(
  samples: readonly Int32Array[],
  sampleRate: number,
  opts: Pick<EncodeFlacOptions, 'bitDepth' | 'blockSize' | 'maxLpcOrder'>,
): Uint8Array {
  const total = samples[0]?.length ?? 0;
  if (samples.some((c) => c.length !== total)) throw new RangeError('encodeFlac: all channels must have the same length.');
  const enc = new FlacStreamEncoder(samples.length, sampleRate, opts);
  const parts = [enc.header(), enc.pushPcm(samples), enc.finish()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  out.set(enc.header(), 0);
  return out;
}

/**
 * FLAC written a piece at a time (long exports): `header()` first (STREAMINFO without the length,
 * frame sizes and MD5 yet), then the frames as audio is pushed (whole blocks; the rest waits for the
 * next push), `finish()` for the last block, and `header()` again, now complete, to write over the
 * first one (it has the same size). The bytes are encodeFlac's, however the audio is split.
 */
export class FlacStreamEncoder {
  private readonly block: number;
  private readonly maxLpc: number;
  private readonly bps: FlacBitDepth;
  private readonly quantizer: PcmQuantizer;
  private readonly work: Workspace;
  private readonly md5 = new Md5();
  /** Samples waiting for a whole block. */
  private readonly pending: Int32Array[];
  private pendingLength = 0;
  private frame = 0;
  private total = 0;
  private minFrame = Infinity;
  private maxFrame = 0;

  constructor(
    readonly numChannels: number,
    readonly sampleRate: number,
    opts: Pick<EncodeFlacOptions, 'bitDepth' | 'blockSize' | 'maxLpcOrder' | 'dither' | 'seed'>,
  ) {
    if (numChannels < 1 || numChannels > 8) throw new RangeError('encodeFlac: FLAC holds 1 to 8 channels.');
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350)
      throw new RangeError(`encodeFlac: invalid sample rate ${sampleRate}.`);
    this.bps = opts.bitDepth;
    if (this.bps !== 16 && this.bps !== 24) throw new RangeError('encodeFlac: 16 or 24 bits.');
    this.block = Math.max(16, Math.min(65535, Math.round(opts.blockSize ?? BLOCK)));
    this.maxLpc = Math.max(0, Math.min(32, Math.round(opts.maxLpcOrder ?? 8)));
    this.quantizer = new PcmQuantizer(this.bps, { dither: !!opts.dither, seed: opts.seed });
    this.work = new Workspace(this.block);
    this.pending = Array.from({ length: numChannels }, () => new Int32Array(this.block));
  }

  /** "fLaC" and STREAMINFO (42 bytes): complete once `finish` has run. */
  header(): Uint8Array {
    const w = new BitWriter(42);
    w.write(0x664c6143, 32);
    w.write(1, 1); // last metadata block
    w.write(0, 7); // STREAMINFO
    w.write(34, 24);
    const total = this.total;
    w.write(this.block, 16);
    w.write(this.block, 16);
    w.write(total > 0 && Number.isFinite(this.minFrame) ? this.minFrame : 0, 24);
    w.write(this.maxFrame, 24);
    w.write(this.sampleRate, 20);
    w.write(this.numChannels - 1, 3);
    w.write(this.bps - 1, 5);
    w.write(Math.floor(total / 2 ** 32), 4);
    w.write(total >>> 0, 32);
    const out = w.finish();
    const full = new Uint8Array(42);
    full.set(out, 0);
    if (this.digest) full.set(this.digest, 26);
    return full;
  }

  private finished = false;
  private digest: Uint8Array | null = null;

  /** Float audio: quantized (with the dither carried on), then encoded. */
  push(channels: readonly Float32Array[]): Uint8Array {
    return this.pushPcm(this.quantizer.quantize(channels));
  }

  /** Integer samples: the frames of every whole block they complete. */
  pushPcm(samples: readonly Int32Array[]): Uint8Array {
    if (this.finished) throw new Error('encodeFlac: already finished.');
    if (samples.length !== this.numChannels) throw new RangeError('encodeFlac: wrong number of channels.');
    const n = samples[0]?.length ?? 0;
    const w = new BitWriter(Math.max(1024, Math.ceil((n * this.numChannels * this.bps) / 8 / 2) + 1024));
    let i = 0;
    while (i < n) {
      const take = Math.min(this.block - this.pendingLength, n - i);
      if (this.pendingLength === 0 && take === this.block) {
        // A whole block straight from the input.
        this.encodeBlock(w, samples.map((c) => c.subarray(i, i + take)), take);
      } else {
        samples.forEach((c, ch) => (this.pending[ch] as Int32Array).set(c.subarray(i, i + take), this.pendingLength));
        this.pendingLength += take;
        if (this.pendingLength === this.block) {
          this.encodeBlock(w, this.pending, this.block);
          this.pendingLength = 0;
        }
      }
      i += take;
    }
    return w.finish();
  }

  /** The last (partial) block. Write `header()` over the first 42 bytes afterwards. */
  finish(): Uint8Array {
    const w = new BitWriter(Math.max(1024, Math.ceil((this.pendingLength * this.numChannels * this.bps) / 8) * 2 + 1024));
    if (this.pendingLength > 0) {
      this.encodeBlock(
        w,
        this.pending.map((c) => c.subarray(0, this.pendingLength)),
        this.pendingLength,
      );
      this.pendingLength = 0;
    }
    this.finished = true;
    this.digest = this.md5.digest();
    return w.finish();
  }

  private encodeBlock(w: BitWriter, chans: Int32Array[], bs: number): void {
    this.md5.update(interleavedBytes(chans, bs, this.bps / 8));
    const at = w.bytePos;
    writeFrame(w, chans, bs, this.bps, this.sampleRate, this.frame, this.block, this.maxLpc, this.work);
    const size = w.bytePos - at;
    this.minFrame = Math.min(this.minFrame, size);
    this.maxFrame = Math.max(this.maxFrame, size);
    this.frame++;
    this.total += bs;
  }
}

function interleavedBytes(chans: Int32Array[], n: number, bytesPer: number): Uint8Array {
  const out = new Uint8Array(n * chans.length * bytesPer);
  let o = 0;
  for (let i = 0; i < n; i++)
    for (const c of chans) {
      const v = c[i] as number;
      out[o++] = v & 0xff;
      out[o++] = (v >> 8) & 0xff;
      if (bytesPer === 3) out[o++] = (v >> 16) & 0xff;
    }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Frames

/** Scratch buffers reused across frames. */
class Workspace {
  readonly mid: Int32Array;
  readonly side: Int32Array;
  readonly res: Int32Array;
  readonly windowed: Float64Array;
  private tukey: Float64Array | null = null;
  constructor(block: number) {
    this.mid = new Int32Array(block);
    this.side = new Int32Array(block);
    this.res = new Int32Array(block);
    this.windowed = new Float64Array(block);
  }
  /** Tukey(0.5) window for a block of n samples (cached: nearly every block has the same size). */
  window(n: number): Float64Array {
    if (this.tukey?.length !== n) {
      const w = new Float64Array(n);
      const taper = Math.floor((0.5 * n) / 2);
      for (let i = 0; i < n; i++) {
        let v = 1;
        if (i < taper) v = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
        else if (i >= n - taper) v = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper);
        w[i] = v;
      }
      this.tukey = w;
    }
    return this.tukey;
  }
}

const SAMPLE_RATE_CODES: Record<number, number> = {
  88200: 1,
  176400: 2,
  192000: 3,
  8000: 4,
  16000: 5,
  22050: 6,
  24000: 7,
  32000: 8,
  44100: 9,
  48000: 10,
  96000: 11,
};

function writeFrame(
  w: BitWriter,
  chans: Int32Array[],
  bs: number,
  bps: number,
  sampleRate: number,
  frame: number,
  block: number,
  maxLpc: number,
  work: Workspace,
): void {
  // Channel decorrelation: try every stereo mode, keep the smallest.
  let plans: SubframePlan[];
  let assignment: number;
  if (chans.length === 2) {
    const l = chans[0] as Int32Array;
    const r = chans[1] as Int32Array;
    const mid = work.mid.subarray(0, bs);
    const side = work.side.subarray(0, bs);
    for (let i = 0; i < bs; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      mid[i] = (a + b) >> 1;
      side[i] = a - b;
    }
    // The stereo mode is chosen on the fixed predictors (cheap); LPC then refines the two it keeps.
    const pl = planFixed(l, bps, work);
    const pr = planFixed(r, bps, work);
    const pm = planFixed(mid, bps, work);
    const ps = planFixed(side, bps + 1, work);
    const options: [number, SubframePlan, SubframePlan][] = [
      [1, pl, pr],
      [8, pl, ps],
      [9, ps, pr],
      [10, pm, ps],
    ];
    let best = options[0]!;
    for (const o of options) if (o[1].bits + o[2].bits < best[1].bits + best[2].bits) best = o;
    assignment = best[0];
    plans = [refineLpc(best[1], maxLpc, work), refineLpc(best[2], maxLpc, work)];
  } else {
    plans = chans.map((c) => refineLpc(planFixed(c, bps, work), maxLpc, work));
    assignment = chans.length - 1;
  }

  const start = w.bytePos;
  // Header.
  w.write(0b11111111111110, 14);
  w.write(0, 1);
  w.write(0, 1); // fixed block size
  const bsCode = bs === block && block === 4096 ? 12 : bs <= 256 ? 6 : 7;
  w.write(bsCode, 4);
  const srCode = SAMPLE_RATE_CODES[sampleRate] ?? 0;
  w.write(srCode, 4);
  w.write(assignment, 4);
  w.write(bps === 16 ? 4 : 6, 3);
  w.write(0, 1);
  writeUtf8(w, frame);
  if (bsCode === 6) w.write(bs - 1, 8);
  else if (bsCode === 7) w.write(bs - 1, 16);
  w.write(crc8(w.bytes, start, w.bytePos), 8);
  // Subframes.
  for (const p of plans) p.write(w, work);
  w.align();
  w.write(crc16(w.bytes, start, w.bytePos), 16);
}

function writeUtf8(w: BitWriter, v: number): void {
  if (v < 0x80) {
    w.write(v, 8);
    return;
  }
  let n = 2;
  while (n < 6 && v >= 2 ** (5 * n + 1)) n++;
  const lead = (0xff00 >> n) & 0xff;
  w.write(lead | Math.floor(v / 2 ** (6 * (n - 1))), 8);
  for (let i = n - 2; i >= 0; i--) w.write(0x80 | (Math.floor(v / 2 ** (6 * i)) & 0x3f), 8);
}

// ---------------------------------------------------------------------------------------------
// Subframes

interface SubframePlan {
  /** The samples and their bits per sample (side channels have one more). */
  x: Int32Array;
  bps: number;
  /** Estimated size in bits. */
  bits: number;
  /** Writes it; residuals are recomputed here (planning keeps no copies). */
  write(w: BitWriter, work: Workspace): void;
}

/** The smallest of CONSTANT, VERBATIM and FIXED orders 0–4. */
function planFixed(x: Int32Array, bps: number, work: Workspace): SubframePlan {
  const n = x.length;
  const first = x[0] as number;
  let constant = true;
  for (let i = 1; i < n; i++)
    if (x[i] !== first) {
      constant = false;
      break;
    }
  if (constant)
    return {
      x,
      bps,
      bits: 8 + bps,
      write: (w) => {
        w.write(0, 8); // 0 + CONSTANT + no wasted bits
        w.writeSigned(first, bps);
      },
    };

  let best: SubframePlan = {
    x,
    bps,
    bits: 8 + n * bps,
    write: (w) => {
      w.write(0b00000010, 8); // VERBATIM
      for (let i = 0; i < n; i++) w.writeSigned(x[i] as number, bps);
    },
  };
  const res = work.res.subarray(0, n);
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    fixedResidual(x, order, res);
    const rice = planRice(res, order, n);
    const bits = 8 + order * bps + rice.bits;
    if (bits < best.bits) {
      const o = order;
      best = {
        x,
        bps,
        bits,
        write: (w, ws) => {
          w.write(0b00010000 | (o << 1), 8);
          for (let i = 0; i < o; i++) w.writeSigned(x[i] as number, bps);
          const r = ws.res.subarray(0, n);
          fixedResidual(x, o, r);
          writeRice(w, r.subarray(o), rice, o);
        },
      };
    }
  }
  return best;
}

/** Tries LPC on a channel and keeps it when it beats the fixed plan. */
function refineLpc(fixed: SubframePlan, maxLpc: number, work: Workspace): SubframePlan {
  const n = fixed.x.length;
  if (maxLpc <= 0 || n <= 32 || fixed.bits <= 8 + fixed.bps) return fixed;
  const lpc = planLpc(fixed.x, fixed.bps, Math.min(maxLpc, n - 1), work);
  return lpc && lpc.bits < fixed.bits ? lpc : fixed;
}

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

/** LPC with the order the prediction error favours (coefficients quantized like libFLAC). */
function planLpc(x: Int32Array, bps: number, maxOrder: number, work: Workspace): SubframePlan | null {
  const n = x.length;
  const tukey = work.window(n);
  const win = work.windowed;
  for (let i = 0; i < n; i++) win[i] = (x[i] as number) * (tukey[i] as number);
  const r = new Float64Array(maxOrder + 1);
  for (let lag = 0; lag <= maxOrder; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (win[i] as number) * (win[i - lag] as number);
    r[lag] = s;
  }
  if (!(r[0]! > 0)) return null;
  r[0] = r[0]! * (1 + 1e-10);
  // Levinson–Durbin: coefficients and prediction error for every order.
  const coefs: Float64Array[] = [];
  const errors: number[] = [];
  let a = new Float64Array(0);
  let err = r[0]!;
  for (let m = 1; m <= maxOrder; m++) {
    let acc = r[m]!;
    for (let j = 0; j < m - 1; j++) acc -= a[j]! * r[m - 1 - j]!;
    const k = acc / err;
    const next = new Float64Array(m);
    for (let j = 0; j < m - 1; j++) next[j] = a[j]! - k * a[m - 2 - j]!;
    next[m - 1] = k;
    a = next;
    err *= 1 - k * k;
    if (!(err > 0)) break;
    coefs.push(a);
    errors.push(err);
  }
  if (coefs.length === 0) return null;
  // Expected bits per order: residual bits from the error, plus warm-up and coefficients.
  const precision = bps <= 16 ? 14 : 15;
  let order = 1;
  let bestEst = Infinity;
  for (let m = 1; m <= coefs.length; m++) {
    const e = errors[m - 1]! / n;
    const perSample = e > 1 ? 0.5 * Math.log2(e) + 0.5 : 0.5;
    const est = (n - m) * perSample + m * (bps + precision);
    if (est < bestEst) {
      bestEst = est;
      order = m;
    }
  }
  const q = quantizeCoefs(coefs[order - 1]!, precision);
  if (!q) return null;
  const res = work.res.subarray(0, n);
  if (!lpcResidual(x, order, q, res)) return null;
  const rice = planRice(res, order, n);
  const bits = 8 + order * bps + 4 + 5 + order * precision + rice.bits;
  return {
    x,
    bps,
    bits,
    write: (w, ws) => {
      w.write(0b01000000 | ((order - 1) << 1), 8);
      for (let i = 0; i < order; i++) w.writeSigned(x[i] as number, bps);
      w.write(precision - 1, 4);
      w.writeSigned(q.shift, 5);
      for (let j = 0; j < order; j++) w.writeSigned(q.coefs[j] as number, precision);
      const r = ws.res.subarray(0, n);
      lpcResidual(x, order, q, r);
      writeRice(w, r.subarray(order), rice, order);
    },
  };
}

/** x[i] − (Σ q·x[i−1−j]) >> shift for i ≥ order; false when a residual doesn't fit in 31 bits. */
function lpcResidual(x: Int32Array, order: number, q: { coefs: Int32Array; shift: number }, out: Int32Array): boolean {
  const n = x.length;
  const c = q.coefs;
  // Scaling by a power of two is exact in floating point, so floor(sum · 2^−shift) is sum >> shift.
  const inv = 2 ** -q.shift;
  const limit = 2 ** 30;
  for (let i = 0; i < order; i++) out[i] = 0;
  for (let i = order; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += (c[j] as number) * (x[i - 1 - j] as number);
    const e = (x[i] as number) - Math.floor(sum * inv);
    if (e >= limit || e <= -limit) return false;
    out[i] = e;
  }
  return true;
}

function quantizeCoefs(a: Float64Array, precision: number): { coefs: Int32Array; shift: number } | null {
  let cmax = 0;
  for (const c of a) cmax = Math.max(cmax, Math.abs(c));
  if (!(cmax > 0) || !Number.isFinite(cmax)) return null;
  const log2cmax = Math.floor(Math.log2(cmax)) + 1;
  let shift = precision - 1 - log2cmax;
  if (shift > 15) shift = 15;
  if (shift < 0) return null;
  const lim = 2 ** (precision - 1);
  const coefs = new Int32Array(a.length);
  let carry = 0;
  for (let j = 0; j < a.length; j++) {
    carry += a[j]! * 2 ** shift;
    let v = Math.round(carry);
    if (v > lim - 1) v = lim - 1;
    else if (v < -lim) v = -lim;
    carry -= v;
    coefs[j] = v;
  }
  return { coefs, shift };
}

// ---------------------------------------------------------------------------------------------
// Rice coding

interface RicePlan {
  bits: number;
  order: number;
  params: number[];
  /** 0: 4-bit parameters, 1: 5-bit parameters. */
  method: 0 | 1;
}

const zigzag = (v: number) => (v >= 0 ? 2 * v : -2 * v - 1);

/** The cheapest partition order and Rice parameters for residual[predOrder…n). */
function planRice(res: Int32Array, predOrder: number, n: number): RicePlan {
  let maxOrder = 0;
  while (maxOrder < 8 && n % (1 << (maxOrder + 1)) === 0 && n >> (maxOrder + 1) > predOrder) maxOrder++;
  // Sums of zigzagged residuals per finest partition, combined pairwise for coarser orders.
  const parts = 1 << maxOrder;
  const size = n >> maxOrder;
  let sums = new Float64Array(parts);
  for (let p = 0; p < parts; p++) {
    let s = 0;
    for (let i = Math.max(p * size, predOrder); i < (p + 1) * size; i++) s += zigzag(res[i] as number);
    sums[p] = s;
  }
  let best: RicePlan | null = null;
  for (let order = maxOrder; order >= 0; order--) {
    const count = 1 << order;
    const psize = n >> order;
    const params: number[] = [];
    let bits = 2 + 4;
    let maxParam = 0;
    for (let p = 0; p < count; p++) {
      const m = p === 0 ? psize - predOrder : psize;
      const { k, cost } = riceParam(sums[p] as number, m);
      params.push(k);
      maxParam = Math.max(maxParam, k);
      bits += cost;
    }
    const method = maxParam > 14 ? 1 : 0;
    bits += count * (method ? 5 : 4);
    if (!best || bits < best.bits) best = { bits, order, params, method };
    if (order > 0) {
      const next = new Float64Array(count / 2);
      for (let p = 0; p < count / 2; p++) next[p] = (sums[2 * p] as number) + (sums[2 * p + 1] as number);
      sums = next;
    }
  }
  return best as RicePlan;
}

/** Best Rice parameter for m values summing to `sum` (estimated bits). */
function riceParam(sum: number, m: number): { k: number; cost: number } {
  if (m <= 0) return { k: 0, cost: 0 };
  const mean = sum / m;
  let k = mean > 1 ? Math.min(30, Math.floor(Math.log2(mean))) : 0;
  const cost = (kk: number) => m * (kk + 1) + sum / 2 ** kk;
  if (k < 30 && cost(k + 1) < cost(k)) k++;
  if (k > 0 && cost(k - 1) < cost(k)) k--;
  return { k, cost: Math.ceil(cost(k)) };
}

/** Writes the residual (which excludes the `warmup` samples the predictor starts from). */
function writeRice(w: BitWriter, residual: Int32Array, plan: RicePlan, warmup: number): void {
  w.write(plan.method, 2);
  w.write(plan.order, 4);
  const count = 1 << plan.order;
  const psize = (residual.length + warmup) >> plan.order;
  let i = 0;
  for (let p = 0; p < count; p++) {
    const k = plan.params[p] as number;
    w.write(k, plan.method ? 5 : 4);
    const m = p === 0 ? psize - warmup : psize;
    for (let j = 0; j < m; j++, i++) w.writeRice(zigzag(residual[i] as number), k);
  }
}

// ---------------------------------------------------------------------------------------------
// Bits

class BitWriter {
  bytes: Uint8Array;
  bytePos = 0;
  private acc = 0;
  private n = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  /** Writes the low `bits` bits of `value` (bits ≤ 32). */
  write(value: number, bits: number): void {
    if (bits > 24) {
      this.write(Math.floor(value / 2 ** 24) & ((1 << (bits - 24)) - 1), bits - 24);
      this.write(value & 0xffffff, 24);
      return;
    }
    if (bits === 0) return;
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.push((this.acc >>> this.n) & 0xff);
    }
    this.acc &= (1 << this.n) - 1;
  }

  writeSigned(value: number, bits: number): void {
    const v = value < 0 ? value + 2 ** bits : value;
    this.write(v, bits);
  }

  /** u as q = u >> k zeros, a one, then the low k bits. */
  writeRice(u: number, k: number): void {
    let q = Math.floor(u / 2 ** k);
    while (q > 24) {
      this.write(0, 24);
      q -= 24;
    }
    this.write(1, q + 1);
    if (k > 0) this.write(u % 2 ** k, k);
  }

  align(): void {
    if (this.n > 0) this.write(0, 8 - this.n);
  }

  finish(): Uint8Array {
    this.align();
    return this.bytes.slice(0, this.bytePos);
  }

  private push(b: number): void {
    if (this.bytePos === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.bytePos++] = b;
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let b = 0; b < 8; b++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

function crc8(bytes: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ (bytes[i] as number)] as number;
  return c;
}

function crc16(bytes: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) ^ (CRC16[((c >> 8) ^ (bytes[i] as number)) & 0xff] as number)) & 0xffff;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Decoding

export interface DecodedFlac {
  sampleRate: number;
  bitDepth: number;
  /** Integer samples per channel. */
  channels: Int32Array[];
  /** The MD5 STREAMINFO declares (hex), and whether the decoded audio matches it. */
  md5: string;
  md5Ok: boolean;
}

export class FlacError extends Error {}

/** Decodes a FLAC stream (fixed or variable block size, every subframe type, CRCs checked). */
export function decodeFlac(bytes: Uint8Array): DecodedFlac {
  const r = new BitReader(bytes);
  if (r.read(32) !== 0x664c6143) throw new FlacError('Not a FLAC file.');
  let sampleRate = 0;
  let bps = 0;
  let nch = 0;
  let total = 0;
  let md5 = '';
  for (let last = false; !last; ) {
    last = r.read(1) === 1;
    const type = r.read(7);
    const len = r.read(24);
    const at = r.bytePos;
    if (type === 0) {
      r.read(16);
      r.read(16);
      r.read(24);
      r.read(24);
      sampleRate = r.read(20);
      nch = r.read(3) + 1;
      bps = r.read(5) + 1;
      total = r.read(4) * 2 ** 32 + r.read(32);
      md5 = Array.from(bytes.subarray(r.bytePos, r.bytePos + 16), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    r.seek(at + len);
  }
  if (!sampleRate) throw new FlacError('FLAC file without STREAMINFO.');
  const out = Array.from({ length: nch }, () => new Int32Array(total));
  let pos = 0;
  while (pos < total && r.bytePos < bytes.length) {
    const start = r.bytePos;
    if (r.read(14) !== 0b11111111111110) throw new FlacError('Lost FLAC frame sync.');
    r.read(1);
    r.read(1);
    const bsCode = r.read(4);
    const srCode = r.read(4);
    const assignment = r.read(4);
    const sizeCode = r.read(3);
    r.read(1);
    r.readUtf8();
    let bs: number;
    if (bsCode === 1) bs = 192;
    else if (bsCode >= 2 && bsCode <= 5) bs = 576 << (bsCode - 2);
    else if (bsCode === 6) bs = r.read(8) + 1;
    else if (bsCode === 7) bs = r.read(16) + 1;
    else if (bsCode >= 8) bs = 256 << (bsCode - 8);
    else throw new FlacError('Reserved FLAC block size.');
    if (srCode === 12) r.read(8);
    else if (srCode === 13 || srCode === 14) r.read(16);
    const fbps = [bps, 8, 12, 0, 16, 20, 24, 32][sizeCode] as number;
    const crc = crc8(bytes, start, r.bytePos);
    if (r.read(8) !== crc) throw new FlacError('FLAC frame header CRC mismatch.');
    const chans: Int32Array[] = [];
    const frameCh = assignment < 8 ? assignment + 1 : 2;
    for (let c = 0; c < frameCh; c++) {
      const extra = (assignment === 8 && c === 1) || (assignment === 9 && c === 0) || (assignment === 10 && c === 1) ? 1 : 0;
      chans.push(readSubframe(r, bs, fbps + extra));
    }
    r.alignByte();
    const fcrc = crc16(bytes, start, r.bytePos);
    if (r.read(16) !== fcrc) throw new FlacError('FLAC frame CRC mismatch.');
    const n = Math.min(bs, total - pos);
    for (let i = 0; i < n; i++) {
      if (assignment === 8) {
        const l = chans[0]![i]!;
        out[0]![pos + i] = l;
        out[1]![pos + i] = l - chans[1]![i]!;
      } else if (assignment === 9) {
        const rr = chans[1]![i]!;
        out[0]![pos + i] = chans[0]![i]! + rr;
        out[1]![pos + i] = rr;
      } else if (assignment === 10) {
        const side = chans[1]![i]!;
        const mid = chans[0]![i]! * 2 + (side & 1);
        out[0]![pos + i] = (mid + side) >> 1;
        out[1]![pos + i] = (mid - side) >> 1;
      } else for (let c = 0; c < nch; c++) out[c]![pos + i] = chans[c]![i]!;
    }
    pos += n;
  }
  const check = new Md5();
  for (let s = 0; s < total; s += 4096) {
    const n = Math.min(4096, total - s);
    check.update(interleavedBytes(out.map((c) => c.subarray(s, s + n)), n, Math.ceil(bps / 8)));
  }
  const got = Array.from(check.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
  return { sampleRate, bitDepth: bps, channels: out, md5, md5Ok: md5 === '0'.repeat(32) || got === md5 };
}

function readSubframe(r: BitReader, bs: number, bps: number): Int32Array {
  r.read(1);
  const type = r.read(6);
  let wasted = 0;
  if (r.read(1)) wasted = r.readUnary() + 1;
  const b = bps - wasted;
  const x = new Int32Array(bs);
  if (type === 0) {
    const v = r.readSigned(b);
    x.fill(v);
  } else if (type === 1) {
    for (let i = 0; i < bs; i++) x[i] = r.readSigned(b);
  } else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) x[i] = r.readSigned(b);
    readResidual(r, bs, order, x);
    for (let i = order; i < bs; i++) {
      const e = x[i]!;
      if (order === 1) x[i] = e + x[i - 1]!;
      else if (order === 2) x[i] = e + 2 * x[i - 1]! - x[i - 2]!;
      else if (order === 3) x[i] = e + 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!;
      else if (order === 4) x[i] = e + 4 * x[i - 1]! - 6 * x[i - 2]! + 4 * x[i - 3]! - x[i - 4]!;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) x[i] = r.readSigned(b);
    const precision = r.read(4) + 1;
    const shift = r.readSigned(5);
    const q: number[] = [];
    for (let j = 0; j < order; j++) q.push(r.readSigned(precision));
    readResidual(r, bs, order, x);
    for (let i = order; i < bs; i++) {
      let sum = 0;
      for (let j = 0; j < order; j++) sum += q[j]! * x[i - 1 - j]!;
      x[i] = x[i]! + Math.floor(sum / 2 ** shift);
    }
  } else throw new FlacError(`Reserved FLAC subframe type ${type}.`);
  if (wasted) for (let i = 0; i < bs; i++) x[i] = x[i]! * 2 ** wasted;
  return x;
}

function readResidual(r: BitReader, bs: number, order: number, x: Int32Array): void {
  const method = r.read(2);
  if (method > 1) throw new FlacError('Reserved FLAC residual coding method.');
  const porder = r.read(4);
  const count = 1 << porder;
  const psize = bs >> porder;
  const pbits = method ? 5 : 4;
  const escape = method ? 31 : 15;
  let i = order;
  for (let p = 0; p < count; p++) {
    const k = r.read(pbits);
    const m = p === 0 ? psize - order : psize;
    if (k === escape) {
      const raw = r.read(5);
      for (let j = 0; j < m; j++) x[i++] = raw ? r.readSigned(raw) : 0;
    } else
      for (let j = 0; j < m; j++) {
        const u = r.readUnary() * 2 ** k + (k ? r.read(k) : 0);
        x[i++] = u % 2 ? -(u + 1) / 2 : u / 2;
      }
  }
}

class BitReader {
  bytePos = 0;
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.bytePos >= this.bytes.length) throw new FlacError('FLAC stream ends early.');
      const b = ((this.bytes[this.bytePos] as number) >> (7 - this.bit)) & 1;
      v = v * 2 + b;
      if (++this.bit === 8) {
        this.bit = 0;
        this.bytePos++;
      }
    }
    return v;
  }

  readSigned(n: number): number {
    const v = this.read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  readUnary(): number {
    let q = 0;
    while (this.read(1) === 0) q++;
    return q;
  }

  readUtf8(): number {
    let v = this.read(8);
    if (v < 0x80) return v;
    let n = 0;
    while (v & (0x80 >> n)) n++;
    v &= (1 << (7 - n)) - 1;
    for (let i = 1; i < n; i++) v = v * 64 + (this.read(8) & 0x3f);
    return v;
  }

  alignByte(): void {
    if (this.bit) {
      this.bit = 0;
      this.bytePos++;
    }
  }

  seek(byte: number): void {
    this.bytePos = byte;
    this.bit = 0;
  }
}
