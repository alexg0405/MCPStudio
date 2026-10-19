import { monoReaderOf } from './mono';
import { detectOnsetsLazy } from './onsets';
import { COARSE_RATE_HZ, createSimilaritySearch, decimateMix, type SimilaritySearch } from './similarity';
import { TimeMap } from './time-map';
import { placeZones } from './zones';

export interface StretchOptions {
  sampleRate: number;
  /** Frame length (default 40 ms). */
  frameMs?: number;
  /** How far a frame may move to match the previous one (default 12 ms). */
  toleranceMs?: number;
  /** Keep attacks whole and on time (default true). */
  transients?: boolean;
}

/** Finished output: `chunk[c][0..n)` are the frames from `at` on (valid only during the call). */
export type StretchSink = (at: number, chunk: readonly Float32Array[], n: number) => void;

const DEFAULT_FRAME_MS = 40;
const DEFAULT_TOLERANCE_MS = 12;
/** A frame is never shorter than 32 frames (a half frame of 16). */
const MIN_HALF_FRAME = 16;
/** A scale this close to 1 is a copy. */
const UNITY_SCALE_EPSILON = 1e-9;
/** Entering a kept attack, a frame may only shift by this fraction of the tolerance, so the hit lands on its stretched time. */
const ATTACK_ENTRY_TOLERANCE_DIVISOR = 6;

/** Frame sizes in frames at the signal's rate. */
interface FrameGeometry {
  /** Half a frame: the hop between frames and the overlap that has to match. */
  half: number;
  /** A whole frame (two halves). */
  length: number;
  /** How far a frame may move to match the previous one. */
  tolerance: number;
}

function frameGeometry(opts: StretchOptions): FrameGeometry {
  const half = Math.max(
    MIN_HALF_FRAME,
    Math.round((((opts.frameMs ?? DEFAULT_FRAME_MS) / 1000) * opts.sampleRate) / 2),
  );
  const tolerance = Math.max(1, Math.round(((opts.toleranceMs ?? DEFAULT_TOLERANCE_MS) / 1000) * opts.sampleRate));
  return { half, length: half * 2, tolerance };
}

/** Periodic Hann: frames half a frame apart sum to exactly 1. */
function periodicHann(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let n = 0; n < length; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / length);
  return window;
}

function assertScale(scale: number): void {
  if (!(scale > 0) || !Number.isFinite(scale))
    throw new RangeError('timeStretch: the scale must be a positive number.');
}

/**
 * Returns the channels `scale` times as long (scale > 1 slows down), same pitch. The output has
 * exactly round(length · scale) frames.
 */
export function timeStretch(channels: readonly Float32Array[], scale: number, opts: StretchOptions): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  assertScale(scale);
  const outLen = Math.max(0, Math.round(inLen * scale));
  const outs = channels.map(() => new Float32Array(outLen));
  stretchStream(channels, scale, opts, (at, chunk, n) => {
    outs.forEach((out, c) => out.set((chunk[c] as Float32Array).subarray(0, n), at));
  });
  return outs;
}

/**
 * `timeStretch` that hands the output over as it is finished (half a frame at a time, in order, each frame of the
 * output exactly once) instead of building it: the caller decides where it goes (16-bit PCM, `stretchToPcm16`), so a
 * long song never exists as floats twice. The input isn't copied either: the mono mix for the similarity search is
 * read from the channels a window at a time. Every value is the same as `timeStretch` made before.
 */
export function stretchStream(
  channels: readonly Float32Array[],
  scale: number,
  opts: StretchOptions,
  sink: StretchSink,
): void {
  const inLen = channels[0]?.length ?? 0;
  assertScale(scale);
  const outLen = Math.max(0, Math.round(inLen * scale));
  if (inLen === 0 || outLen === 0) return;
  if (Math.abs(scale - 1) < UNITY_SCALE_EPSILON) {
    sink(
      0,
      channels.map((c) => c.subarray(0, outLen)),
      outLen,
    );
    return;
  }
  const sampleRate = opts.sampleRate;
  const geometry = frameGeometry(opts);
  const { half, length: frameLength, tolerance } = geometry;
  const readMono = monoReaderOf(channels, inLen);

  // Decimated copy for the coarse pass, over the signal padded on both sides as the fine search sees it.
  const pad = frameLength + 2 * tolerance + 64;
  const decimation = Math.max(1, Math.round(sampleRate / COARSE_RATE_HZ));
  const decimatedPad = Math.ceil(pad / decimation);
  const decimated = decimateMix(readMono, inLen, pad, decimation);
  const search = createSimilaritySearch(decimated, readMono, { halfFrame: half, decimation, decimatedPad }, tolerance);

  // The time map: output frame → input frame, slope 1/scale except around kept attacks (slope 1).
  const pre = frameLength + half + tolerance;
  const post = half + tolerance;
  const zones =
    opts.transients === false
      ? []
      : placeZones(detectOnsetsLazy(inLen, readMono, sampleRate), scale, pre, post, half, inLen, outLen);
  const timeMap = new TimeMap(zones, pre, post, inLen, outLen);

  overlapAdd(channels, { outLen, geometry, search, timeMap, sink });
}

/** What the frame loop works with. */
interface OverlapAddInput {
  outLen: number;
  geometry: FrameGeometry;
  search: SimilaritySearch;
  timeMap: TimeMap;
  sink: StretchSink;
}

/**
 * Builds the output frame by frame: each frame is the input from the start `chooseStart` picks,
 * Hann-windowed and added to the frames before it; every half frame that no later frame will touch
 * goes to the sink.
 */
function overlapAdd(channels: readonly Float32Array[], input: OverlapAddInput): void {
  const { outLen, geometry, search, timeMap, sink } = input;
  const { half, length: frameLength } = geometry;
  const inLen = channels[0]?.length ?? 0;
  const window = periodicHann(frameLength);
  const frames = Math.ceil(outLen / half) + 1;
  // The frames that overlap the half frame being finished: `acc[0..N)` is the output from `o` on.
  const acc = channels.map(() => new Float32Array(frameLength));
  // Reused for every frame: the loop allocates nothing.
  const choice: StartChoice = { nominal: 0, zone: -1, prevZone: -1, prevStart: 0, inLen, geometry, search };
  const placement: FramePlacement = { start: 0, m: 0, o: 0, outLen, window, half, inLen };
  for (let m = 0; m < frames; m++) {
    const o = m * half;
    choice.nominal = Math.round(timeMap.inputFrameAt(o));
    choice.zone = timeMap.zoneAt(o);
    const start = m > 0 ? chooseStart(choice) : choice.nominal;
    choice.prevStart = start;
    choice.prevZone = choice.zone;
    placement.start = start;
    placement.m = m;
    placement.o = o;
    for (let ci = 0; ci < channels.length; ci++) {
      addFrame(channels[ci] as Float32Array, acc[ci] as Float32Array, placement);
    }
    // The first half of the window is finished (the next frame only adds from `o + Hs` on).
    const done = Math.min(half, outLen - o);
    if (done > 0) sink(o, acc, done);
    for (const y of acc) {
      y.copyWithin(0, half, frameLength);
      y.fill(0, half, frameLength);
    }
  }
}

interface StartChoice {
  nominal: number;
  zone: number;
  prevZone: number;
  prevStart: number;
  inLen: number;
  geometry: FrameGeometry;
  search: SimilaritySearch;
}

/**
 * Where in the input a frame (not the first) starts. Inside a kept attack it continues the previous
 * frame exactly (the input at its own speed); entering one it may only shift a little, so the hit lands
 * on its stretched time; elsewhere it moves up to the tolerance to the spot that best continues the
 * previous frame.
 */
function chooseStart(c: StartChoice): number {
  const { nominal, zone, prevStart, inLen } = c;
  const { half, tolerance } = c.geometry;
  if (zone >= 0 && zone === c.prevZone) return prevStart + half;
  const reach = zone >= 0 ? Math.max(1, Math.round(tolerance / ATTACK_ENTRY_TOLERANCE_DIVISOR)) : tolerance;
  const lo = Math.max(-nominal, -reach);
  const hi = Math.min(reach, inLen - 1 - nominal);
  if (hi < lo) return nominal;
  return c.search(prevStart + half, nominal, lo, hi);
}

interface FramePlacement {
  start: number;
  m: number;
  o: number;
  outLen: number;
  window: Float32Array;
  half: number;
  inLen: number;
}

/** Adds one channel's frame (the input from `start`, Hann-windowed) into the accumulator. */
function addFrame(x: Float32Array, y: Float32Array, f: FramePlacement): void {
  const { start, m, o, outLen, window, half, inLen } = f;
  const frameLength = window.length;
  const end = Math.min(frameLength, outLen - o);
  // Nothing comes before the first frame: its first half goes in unwindowed.
  const from = m === 0 ? half : 0;
  if (m === 0) for (let n = 0; n < Math.min(half, end); n++) y[n] = (y[n] as number) + (x[start + n] ?? 0);
  if (start >= 0 && start + frameLength <= inLen) {
    for (let n = from; n < end; n++) y[n] = (y[n] as number) + (window[n] as number) * (x[start + n] as number);
    return;
  }
  for (let n = from; n < end; n++) {
    const i = start + n;
    if (i >= 0 && i < inLen) y[n] = (y[n] as number) + (window[n] as number) * (x[i] as number);
  }
}
