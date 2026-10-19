/**
 * TD-PSOLA (time-domain pitch-synchronous overlap-add): changes the pitch of voiced audio without
 * changing its speed, and, unlike a resample, without moving its formants (the spectral envelope
 * that makes a vowel a vowel stays put while the harmonics move). Pure and deterministic (no
 * DOM, no random), so it runs in a Worker and in Node tests.
 *
 * How it works:
 *  1. Pitch marks. In each voiced run (frames with f0 > 0) the phase of the fundamental is read by
 *     complex demodulation (x · e^(−jΦ), Φ the phase of the pitch track, averaged over two periods:
 *     only the fundamental survives) and a mark is put wherever the fundamental's phase crosses a
 *     multiple of 2π, at a fraction of a sample. Between and around runs, marks every 8 ms hold the
 *     unvoiced sound.
 *  2. Synthesis marks follow the analysis time (speed unchanged): the next one lies one analysis
 *     period divided by the pitch ratio after the last. Each takes the analysis mark nearest to it
 *     (so a rise repeats some grains and a fall skips some) and overlap-adds its grain, a window of
 *     two periods read with cubic interpolation so grains land on fractions of a sample.
 *  3. Every output sample is divided by the sum of its windows (so levels never modulate), and
 *     blended towards the input where no window reaches. With a ratio of 1 the grains rebuild the
 *     input (within 1e-9), so untouched stretches come back unchanged and a edit has no seams.
 *
 * Measured: the pitch ratio is within 0.1 cent on a synthetic voice; a formant moves < 3 % at ±5
 * semitones (psola.test.ts).
 */

/** The pitch track the marks follow, and the shift to apply. */
export interface PsolaTrack {
  /** Fundamental in Hz per frame, 0 where unvoiced. */
  f0: Float32Array;
  /** Shift in cents per frame (positive raises the pitch); frames are the same as `f0`'s. */
  shift: Float32Array;
  /** Frame spacing in samples. */
  hop: number;
  /** Sample position of frame 0's centre (may be negative). */
  t0: number;
}

/** Settings of a pitch shift: an optional progress callback (0..1) and the largest shift either way in cents. */
export interface PsolaOptions {
  /** Called now and then with 0..1 (a long render shows progress). */
  onProgress?: (fraction: number) => void;
  /** Largest shift either way, cents (default 1200). */
  maxCents?: number;
  /**
   * Moves the formants by this factor (default 1 = they stay): each grain is read this much faster, so its spectral envelope
   * (the vowel) scales while the pitch still follows the track. Harmony voices use it to sound like another singer.
   */
  formantRatio?: number;
}

/** Spacing of the marks that carry unvoiced sound, seconds. */
const UNVOICED_PERIOD = 0.008;
/** Frames shorter than this many hops are not a voiced run. */
const MIN_RUN = 3;
/** Shifts below this many cents leave the sound as it is. */
const NEGLIGIBLE_CENTS = 0.001;
/** The shifted range reaches this far (s) beyond the first and last shifted frame, so the edit has no seams. */
const RANGE_MARGIN_SEC = 0.06;
/** Fewer marks than this and there is nothing to overlap-add. */
const MIN_MARKS = 3;
/** The grain ring is at least this many samples, and holds this many grains of the longest reach. */
const MIN_RING_SIZE = 1024;
const RING_GRAINS = 8;
/** Output samples whose windows add up to less than this are left as the input. */
const MIN_WINDOW_SUM = 1e-12;
/** A grain reaches at least this share of a synthesis step to each side, so a fall leaves no gaps. */
const GRAIN_OVERLAP = 0.75;
const TWO_PI = Math.PI * 2;

interface Run {
  /** First and last sample of the run (inclusive). */
  a: number;
  b: number;
}

/** Voiced runs of the track as sample ranges. */
function voicedRuns(track: PsolaTrack, length: number): Run[] {
  const { f0, hop, t0 } = track;
  const runs: Run[] = [];
  let i = 0;
  while (i < f0.length) {
    if (!((f0[i] as number) > 0)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < f0.length && (f0[j + 1] as number) > 0) j++;
    if (j - i + 1 >= MIN_RUN) {
      const a = Math.max(0, Math.round(t0 + (i - 0.5) * hop));
      const b = Math.min(length - 1, Math.round(t0 + (j + 0.5) * hop));
      if (b > a) runs.push({ a, b });
    }
    i = j + 1;
  }
  return runs;
}

/** f0 (Hz) at a sample position: linear between frame centres (unvoiced neighbours count as the voiced one). */
function f0At(track: PsolaTrack, n: number): number {
  const { f0, hop, t0 } = track;
  const pos = (n - t0) / hop;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = f0[Math.min(f0.length - 1, Math.max(0, i))] as number;
  const b = f0[Math.min(f0.length - 1, Math.max(0, i + 1))] as number;
  if (!(a > 0)) return b;
  if (!(b > 0)) return a;
  return a + (b - a) * frac;
}

/** Shift in cents at a sample position (linear between frame centres). */
function shiftAt(track: PsolaTrack, n: number): number {
  const { shift, hop, t0 } = track;
  if (shift.length === 0) return 0;
  const pos = (n - t0) / hop;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = shift[Math.min(shift.length - 1, Math.max(0, i))] as number;
  const b = shift[Math.min(shift.length - 1, Math.max(0, i + 1))] as number;
  return a + (b - a) * frac;
}

/**
 * Pitch marks of a mono signal (sample positions, increasing): in voiced runs at the peaks of the
 * fundamental, elsewhere (between `from` and `to`) every 8 ms.
 */
export function pitchMarks(
  mono: Float32Array,
  sampleRate: number,
  track: PsolaTrack,
  from = 0,
  to = mono.length,
): Float64Array {
  const runs = voicedRuns(track, mono.length);
  const marks: number[] = [];
  const step = Math.max(8, Math.round(UNVOICED_PERIOD * sampleRate));
  let cursor = Math.max(0, from);
  const fill = (upTo: number) => {
    // Unvoiced marks from the cursor to `upTo`; the last one is dropped when it would sit too close to the next mark.
    for (let p = cursor; p < upTo - step * 0.5; p += step) marks.push(p);
  };
  for (const run of runs) {
    // Only the part inside the range (the demodulation reads nothing outside it).
    const part = { a: Math.max(run.a, from), b: Math.min(run.b, to - 1) };
    if (part.b - part.a < 8) continue;
    const runMarks = runPhaseMarks(mono, sampleRate, track, part);
    if (runMarks.length < 2) continue;
    const first = runMarks[0] as number;
    if (first > cursor) fill(first);
    for (const m of runMarks) marks.push(m);
    cursor = (runMarks[runMarks.length - 1] as number) + 1e-6;
  }
  if (cursor < to) fill(to);
  // Marks must increase strictly (unvoiced fill after a run's last mark can't fall behind it).
  const out: number[] = [];
  for (const m of marks) if (out.length === 0 || m > (out[out.length - 1] as number) + 0.5) out.push(m);
  return Float64Array.from(out);
}

/** The lowest pitch (Hz) the phase follows, so a pitch track that dips to 0 inside a run cannot stall it. */
const MIN_TRACKED_HZ = 20;

/** The pitch track's phase over a run and the running sums of x·cos Φ and x·sin Φ (complex demodulation), with the period (samples) at each sample. */
function demodulate(
  x: Float32Array,
  sr: number,
  track: PsolaTrack,
  run: Run,
): { phase: Float64Array; pc: Float64Array; ps: Float64Array; period: Int32Array } {
  const len = run.b - run.a + 1;
  const phase = new Float64Array(len);
  const pc = new Float64Array(len + 1);
  const ps = new Float64Array(len + 1);
  const period = new Int32Array(len);
  let phi = 0;
  for (let k = 0; k < len; k++) {
    const n = run.a + k;
    const f = f0At(track, n);
    phase[k] = phi;
    const v = x[n] as number;
    pc[k + 1] = (pc[k] as number) + v * Math.cos(phi);
    ps[k + 1] = (ps[k] as number) + v * Math.sin(phi);
    period[k] = Math.max(2, Math.round(sr / Math.max(MIN_TRACKED_HZ, f)));
    phi += (TWO_PI * Math.max(MIN_TRACKED_HZ, f)) / sr;
  }
  return { phase, pc, ps, period };
}

/** Marks inside one voiced run, from the phase of the fundamental. */
function runPhaseMarks(x: Float32Array, sr: number, track: PsolaTrack, run: Run): number[] {
  const len = run.b - run.a + 1;
  const { phase, pc, ps, period } = demodulate(x, sr, track, run);
  // The fundamental's phase offset θ over a two-period window; ψ = Φ + θ (unwrapped).
  const marks: number[] = [];
  let prevTheta = 0;
  let unwrap = 0;
  let prevPsi = Number.NaN;
  for (let k = 0; k < len; k++) {
    const h = period[k] as number;
    const lo = Math.max(0, k - h);
    const hi = Math.min(len, k + h + 1);
    const re = (pc[hi] as number) - (pc[lo] as number);
    const im = -((ps[hi] as number) - (ps[lo] as number));
    let theta = Math.atan2(im, re);
    if (k > 0) {
      const d = theta - prevTheta;
      if (d > Math.PI) unwrap -= TWO_PI;
      else if (d < -Math.PI) unwrap += TWO_PI;
    }
    prevTheta = theta;
    theta += unwrap;
    const psi = (phase[k] as number) + theta;
    if (!Number.isNaN(prevPsi)) {
      const k0 = Math.floor(prevPsi / TWO_PI);
      const k1 = Math.floor(psi / TWO_PI);
      if (k1 > k0 && psi > prevPsi) {
        const frac = (k1 * TWO_PI - prevPsi) / (psi - prevPsi);
        marks.push(run.a + k - 1 + frac);
      }
    }
    prevPsi = psi;
  }
  return marks;
}

/** Catmull-Rom interpolation of `x` at a fractional position (samples outside count as 0). */
function cubicAt(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const n = x.length;
  const y0 = i - 1 >= 0 && i - 1 < n ? (x[i - 1] as number) : 0;
  const y1 = i >= 0 && i < n ? (x[i] as number) : 0;
  if (t === 0) return y1;
  const y2 = i + 1 >= 0 && i + 1 < n ? (x[i + 1] as number) : 0;
  const y3 = i + 2 >= 0 && i + 2 < n ? (x[i + 2] as number) : 0;
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}

/** The sample range [from, to) that has a shift (the first to the last such frame, plus a margin), or null when nothing changes. */
function changedRange(track: PsolaTrack, length: number, sampleRate: number): { from: number; to: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < track.shift.length; i++) {
    if (Math.abs(track.shift[i] as number) > NEGLIGIBLE_CENTS) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const margin = Math.round(RANGE_MARGIN_SEC * sampleRate);
  const from = Math.max(0, Math.round(track.t0 + (first - 1) * track.hop) - margin);
  const to = Math.min(length, Math.round(track.t0 + (last + 1) * track.hop) + margin);
  return to > from ? { from, to } : null;
}

/** The average of the channels over [from, to) (zero elsewhere): the marks are found on this, so stereo images stay together. */
function mixToMono(channels: readonly Float32Array[], length: number, from: number, to: number): Float32Array {
  const mono = new Float32Array(length);
  const inv = 1 / channels.length;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c] as Float32Array;
    for (let n = from; n < to; n++) mono[n] = (mono[n] as number) + (ch[n] as number) * inv;
  }
  return mono;
}

/**
 * Overlap-adds windowed grains into a ring (a few grains long) and writes each output sample once
 * nothing more can reach it: the wet sound divided by the sum of the windows, blended towards the
 * dry input where the windows add up to less than 1.
 */
class GrainAccumulator {
  private readonly wet: Float64Array[];
  private readonly windowSum: Float64Array;
  private readonly mask: number;
  /** Output samples before this one are written. */
  private flushed: number;

  /**
   * `reach` is how far a grain can stretch to either side; the ring holds eight of them.
   * `firstMark` is where synthesis starts.
   */
  constructor(
    private readonly channels: readonly Float32Array[],
    private readonly out: Float32Array[],
    private readonly from: number,
    private readonly to: number,
    reach: number,
    firstMark: number,
  ) {
    let ringSize = MIN_RING_SIZE;
    while (ringSize < RING_GRAINS * reach) ringSize *= 2;
    this.mask = ringSize - 1;
    this.wet = channels.map(() => new Float64Array(ringSize));
    this.windowSum = new Float64Array(ringSize);
    this.flushed = Math.max(from, Math.floor(firstMark) - reach);
  }

  /**
   * Adds the grain around analysis mark `mark` to the output at synthesis time `ts`: a raised-cosine
   * window `hl` samples to the left and `hr` to the right, reading the input with cubic interpolation.
   */
  addGrain(ts: number, mark: number, hl: number, hr: number, formantRatio: number): void {
    const { wet, windowSum, mask, channels } = this;
    const n0 = Math.max(this.from, Math.ceil(ts - hl));
    const n1 = Math.min(this.to - 1, Math.floor(ts + hr));
    for (let n = n0; n <= n1; n++) {
      const d = n - ts;
      const w = d < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * d) / hl) : 0.5 + 0.5 * Math.cos((Math.PI * d) / hr);
      const slot = n & mask;
      windowSum[slot] = (windowSum[slot] as number) + w;
      // With a ratio of 1 this is `mark + d` exactly, so plain pitch shifts stay bit-identical.
      const pos = mark + d * formantRatio;
      for (let c = 0; c < wet.length; c++) {
        const buf = wet[c] as Float64Array;
        buf[slot] = (buf[slot] as number) + w * cubicAt(channels[c] as Float32Array, pos);
      }
    }
  }

  /** Writes every output sample before `upTo` that has not been written yet, and frees its ring slot. */
  finalize(upTo: number): void {
    const { wet, windowSum, mask, channels, out } = this;
    const end = Math.min(upTo, this.to, channels[0]?.length ?? 0);
    for (; this.flushed < end; this.flushed++) {
      const n = this.flushed;
      const slot = n & mask;
      const w = windowSum[slot] as number;
      if (n >= 0 && w > MIN_WINDOW_SUM) {
        const blend = w < 1 ? w : 1;
        for (let c = 0; c < wet.length; c++) {
          const dry = (channels[c] as Float32Array)[n] as number;
          (out[c] as Float32Array)[n] = dry + ((wet[c] as Float64Array)[slot]! / w - dry) * blend;
        }
      }
      windowSum[slot] = 0;
      for (let c = 0; c < wet.length; c++) (wet[c] as Float64Array)[slot] = 0;
    }
  }
}

/** The longest gap between two neighbouring marks (samples). */
function longestPeriod(marks: Float64Array): number {
  let longest = 0;
  for (let k = 1; k < marks.length; k++) longest = Math.max(longest, (marks[k] as number) - (marks[k - 1] as number));
  return longest;
}

/**
 * Shifts the pitch of every channel by the track's per-frame cents. Returns new channels (the
 * input is not touched); the sound outside the stretch that has a non-zero shift is copied
 * unchanged. The marks come from the mix of the channels, so stereo images stay together.
 */
export function psolaShift(
  channels: readonly Float32Array[],
  sampleRate: number,
  track: PsolaTrack,
  opts: PsolaOptions = {},
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  const out = channels.map((c) => Float32Array.from(c));
  if (length === 0 || track.f0.length === 0) return out;
  const range = changedRange(track, length, sampleRate);
  if (!range) return out;
  const { from, to } = range;
  const marks = pitchMarks(mixToMono(channels, length, from, to), sampleRate, track, from, to);
  if (marks.length < MIN_MARKS) return out;
  // Windows reach at most 1.5 periods each side at the largest shift.
  const reach = Math.ceil(2 * longestPeriod(marks)) + 4;
  const grains = new GrainAccumulator(channels, out, from, to, reach, marks[0] as number);
  const formantRatio = opts.formantRatio ?? 1;
  synthesize(marks, track, { from, to, reach, sampleRate, maxCents: opts.maxCents ?? 1200, formantRatio }, grains, opts.onProgress);
  grains.finalize(to);
  opts.onProgress?.(1);
  return out;
}

/** What the synthesis loop needs besides the marks and the track. */
interface SynthesisRange {
  from: number;
  to: number;
  reach: number;
  sampleRate: number;
  maxCents: number;
  formantRatio: number;
}

/**
 * Walks the synthesis marks: each lies one analysis period divided by the pitch ratio after the last
 * and takes the analysis mark nearest to it (a rise repeats some grains and a fall skips some).
 */
function synthesize(
  marks: Float64Array,
  track: PsolaTrack,
  range: SynthesisRange,
  grains: GrainAccumulator,
  onProgress: PsolaOptions['onProgress'],
): void {
  const { from, to, reach, sampleRate, maxCents, formantRatio } = range;
  const count = marks.length;
  let k = 0;
  while (k + 1 < count && (marks[k] as number) < from) k++;
  let ts = marks[k] as number;
  const end = marks[count - 1] as number;
  const reportEvery = Math.max(1, Math.round(sampleRate)); // about once per second of audio
  let reported = 0;
  while (ts <= end) {
    // The analysis mark nearest to ts.
    while (k + 1 < count && Math.abs((marks[k + 1] as number) - ts) <= Math.abs((marks[k] as number) - ts)) k++;
    const mark = marks[k] as number;
    const left = k > 0 ? mark - (marks[k - 1] as number) : (marks[k + 1] as number) - mark;
    const right = k + 1 < count ? (marks[k + 1] as number) - mark : left;
    const cents = Math.max(-maxCents, Math.min(maxCents, shiftAt(track, ts)));
    const ratio = Math.pow(2, cents / 1200);
    const step = Math.max(1, right / ratio);
    // Longer windows keep a fall of an octave from leaving gaps between grains.
    const hl = Math.max(left, GRAIN_OVERLAP * step);
    const hr = Math.max(right, GRAIN_OVERLAP * step);
    grains.addGrain(ts, mark, hl, hr, formantRatio);
    ts += step;
    grains.finalize(Math.floor(ts - 2 * reach));
    if (onProgress && ts - reported > reportEvery) {
      reported = ts;
      onProgress(Math.min(1, (ts - from) / (to - from)));
    }
  }
}
