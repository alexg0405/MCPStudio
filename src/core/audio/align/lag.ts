/**
 * From the match to the move. The DTW path says, for every moment of the guide, which moment of the clip matches
 * it. The *lag* of a frame is how much later than the guide the clip was there (seconds, positive = the clip was
 * late and its sound moves earlier): output time o plays the clip's own sound from o + lag(o). This file turns the
 * raw path into the lag curve the render follows:
 *
 *  1. smooth it, weighting frames by how much sound both voices have there (in a silence the path is arbitrary, so
 *     it takes the lag of the sound next to it),
 *  2. leave small offsets alone when tightness is low (a dead zone),
 *  3. fade the move out towards the ends of the rendered stretch,
 *  4. keep attacks (consonants, transients) at their own speed: the lag is flat across each one,
 *  5. keep the speed of the sound between half and double where the clip sounds (so the result never sounds like a tape
 *     machine; silences may be squeezed or stretched much more), with each attack pinned to the lag it was given: the
 *     speed change happens in the vowels and gaps before it, so the attack lands where the match put it.
 *
 * "Tightness" 0..100 sets how closely the clip follows the guide: low = only big offsets, smoothly; high = syllable by
 * syllable. All plain arrays of numbers; no DOM.
 */

import { KEEP_AFTER_ATTACK_SEC, KEEP_BEFORE_ATTACK_SEC } from './warp-render';

/** What a tightness value means. */
export interface TightnessSettings {
  /** Width of the smoothing window, seconds. */
  smoothSec: number;
  /** Offsets under this many seconds are left alone (fully at tightness 0, none from `DEAD_ZONE_ENDS_AT` up). */
  deadZoneSec: number;
  /** Cost of every non-diagonal step of the DTW (larger = holds its offset more). */
  stepPenalty: number;
}

/** Smoothing window at tightness 0 and at tightness 100, seconds (between them it changes by a constant ratio). */
const SMOOTH_SEC_LOOSE = 1.2;
const SMOOTH_SEC_TIGHT = 0.03;
/** Dead zone at tightness 0 (seconds); it shrinks to nothing at this tightness. */
const DEAD_ZONE_LOOSE_SEC = 0.06;
const DEAD_ZONE_ENDS_AT = 60;
/** DTW step penalty at tightness 0 and 100 (between them it changes by a constant ratio). */
const PENALTY_LOOSE = 0.5;
const PENALTY_TIGHT = 0.05;

/** Where the clip sounds its speed may be between these multiples of normal… */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
/** …and in silence between these (a gap can be squeezed or stretched without anyone hearing it). */
export const SILENCE_MIN_SPEED = 0.2;
export const SILENCE_MAX_SPEED = 4;

/** An attack stays at its own speed from this long before it to this long after it (seconds): what the render needs. */
const KEEP_BEFORE_SEC = KEEP_BEFORE_ATTACK_SEC;
const KEEP_AFTER_SEC = KEEP_AFTER_ATTACK_SEC;
/** The lag changes over this long on either side of a kept attack, seconds. */
const KEEP_RAMP_SEC = 0.03;
/** The lag taken for a kept attack is read this long after the attack starts, seconds. */
const HOLD_READ_AFTER_SEC = 0.02;

/** Tightness (0..100) as smoothing, dead zone and DTW penalty. */
export function tightnessSettings(tightness: number): TightnessSettings {
  const t = Math.min(100, Math.max(0, tightness));
  const smoothSec = SMOOTH_SEC_LOOSE * Math.pow(SMOOTH_SEC_TIGHT / SMOOTH_SEC_LOOSE, t / 100);
  const deadZoneSec = DEAD_ZONE_LOOSE_SEC * Math.max(0, 1 - t / DEAD_ZONE_ENDS_AT);
  const stepPenalty = PENALTY_LOOSE * Math.pow(PENALTY_TIGHT / PENALTY_LOOSE, t / 100);
  return { smoothSec, deadZoneSec, stepPenalty };
}

/** The lag of every guide frame from the DTW's matched clip frames (seconds). */
export function lagFromPath(matched: Float32Array, hopSec: number): Float32Array {
  const lag = new Float32Array(matched.length);
  for (let i = 0; i < matched.length; i++) lag[i] = ((matched[i] as number) - i) * hopSec;
  return lag;
}

/** Moving average of ±`half` frames weighted by `weight` (edges held). Where the weights are nil it keeps the last value. */
function weightedBox(x: Float32Array, weight: Float32Array, half: number): Float32Array {
  const n = x.length;
  const sumWeighted = new Float64Array(n + 1);
  const sumWeights = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sumWeighted[i + 1] = (sumWeighted[i] as number) + (x[i] as number) * (weight[i] as number);
    sumWeights[i + 1] = (sumWeights[i] as number) + (weight[i] as number);
  }
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const w = (sumWeights[b] as number) - (sumWeights[a] as number);
    if (w > 1e-9) last = ((sumWeighted[b] as number) - (sumWeighted[a] as number)) / w;
    out[i] = last;
  }
  return out;
}

/** Smooths the raw lag: two passes of a weighted moving average (a triangle) of about `smoothSec`. */
export function smoothLag(raw: Float32Array, weight: Float32Array, smoothSec: number, hopSec: number): Float32Array {
  const half = Math.max(0, Math.round(smoothSec / hopSec / 4));
  if (half === 0) return Float32Array.from(raw);
  return weightedBox(weightedBox(raw, weight, half), weight, half);
}

/** Pulls every lag towards 0 by `deadZoneSec` (a lag inside it becomes 0). */
export function applyDeadZone(lag: Float32Array, deadZoneSec: number): Float32Array {
  if (deadZoneSec <= 0) return lag;
  return lag.map((v) => Math.sign(v) * Math.max(0, Math.abs(v) - deadZoneSec));
}

/** An attack of the clip, found on the clip's own sound: the frame (of the clip, at the guide's hop) it starts at. */
export interface ClipAttack {
  /** Seconds on the clip's axis. */
  sec: number;
}

/** A stretch of the output (seconds) in which the clip's sound plays at its own speed. */
export interface KeptSpan {
  fromSec: number;
  toSec: number;
}

/** A stretch of frames whose lag must stay exactly `value` (seconds): a kept attack. */
export interface Pin {
  fromFrame: number;
  toFrame: number;
  value: number;
}

/** The first guide frame whose matched clip frame reaches `clipFrame` (the path never goes backwards). */
function guideFrameOf(matched: Float32Array, clipFrame: number): number {
  let lo = 0;
  let hi = matched.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((matched[mid] as number) < clipFrame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A smooth 0..1 rise (raised cosine). */
const smoothstep = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

/**
 * Keeps attacks sharp: across each one the lag is flat (the sound plays at its own speed there), so the stretch
 * that a change of lag needs happens in the vowels around it, never inside a consonant or a transient. The
 * flat value is the smoothed lag a moment after the attack starts, and the curve reaches it by a short ramp.
 * Returns the changed lag, the spans that were kept and the pins that hold their value.
 */
export function protectAttacks(
  lag: Float32Array,
  matched: Float32Array,
  attacks: readonly ClipAttack[],
  hopSec: number,
  readAfterSec = HOLD_READ_AFTER_SEC,
): { lag: Float32Array; kept: KeptSpan[]; pins: Pin[] } {
  const out = Float32Array.from(lag);
  const kept: KeptSpan[] = [];
  const pins: Pin[] = [];
  const last = lag.length - 1;
  for (const attack of attacks) {
    const frame = guideFrameOf(matched, attack.sec / hopSec);
    const centre = frame * hopSec;
    const hold = lag[Math.min(last, frame + Math.round(readAfterSec / hopSec))] as number;
    const span: KeptSpan = { fromSec: centre - KEEP_BEFORE_SEC, toSec: centre + KEEP_AFTER_SEC };
    const previous = kept[kept.length - 1];
    if (previous && span.fromSec - KEEP_RAMP_SEC < previous.toSec + KEEP_RAMP_SEC) continue;
    kept.push(span);
    pins.push({ fromFrame: Math.max(0, Math.ceil(span.fromSec / hopSec)), toFrame: Math.min(last, Math.floor(span.toSec / hopSec)), value: hold });
    const from = Math.max(0, Math.floor((span.fromSec - KEEP_RAMP_SEC) / hopSec));
    const to = Math.min(last, Math.ceil((span.toSec + KEEP_RAMP_SEC) / hopSec));
    for (let i = from; i <= to; i++) {
      const t = i * hopSec;
      const inside = t >= span.fromSec && t <= span.toSec;
      const weight = inside ? 1 : smoothstep(t < span.fromSec ? 1 - (span.fromSec - t) / KEEP_RAMP_SEC : 1 - (t - span.toSec) / KEEP_RAMP_SEC);
      out[i] = (out[i] as number) + (hold - (out[i] as number)) * weight;
    }
  }
  return { lag: out, kept, pins };
}

/**
 * Fades the move out towards the ends of the rendered stretch, so the sound beyond what the clip plays (which a later
 * trim could reveal) comes back to its own place. `audible` is the part the clip plays (seconds from the start of the
 * rendered stretch); where it begins at the very start there is nothing to fade.
 */
export function fadeEdges(
  lag: Float32Array,
  hopSec: number,
  audible: { fromSec: number; toSec: number },
): Float32Array {
  const out = Float32Array.from(lag);
  const total = (lag.length - 1) * hopSec;
  const inEdge = audible.fromSec;
  const outEdge = total - audible.toSec;
  for (let i = 0; i < out.length; i++) {
    const t = i * hopSec;
    let gain = 1;
    if (inEdge > hopSec && t < audible.fromSec) gain = Math.min(gain, smoothstep(t / inEdge));
    if (outEdge > hopSec && t > audible.toSec) gain = Math.min(gain, smoothstep((total - t) / outEdge));
    out[i] = (out[i] as number) * gain;
  }
  return out;
}

/** How far the lag may change from one frame to the next: `down` (the sound slowed) and `up` (sped up), seconds. */
interface SpeedSteps {
  down: Float64Array;
  up: Float64Array;
}

/**
 * The speed bounds of every frame: between `MIN_SPEED` and `MAX_SPEED` where the clip sounds, and as wide as
 * `SILENCE_MIN_SPEED`–`SILENCE_MAX_SPEED` where it is silent (stretching a silence is inaudible, and it is where the
 * time for a big change between two syllables comes from). `sound` is 0..1 per frame.
 */
function speedSteps(sound: Float32Array, hopSec: number): SpeedSteps {
  const down = new Float64Array(sound.length);
  const up = new Float64Array(sound.length);
  for (let i = 0; i < sound.length; i++) {
    const s = Math.min(1, Math.max(0, sound[i] as number));
    down[i] = (SILENCE_MIN_SPEED + (MIN_SPEED - SILENCE_MIN_SPEED) * s - 1) * hopSec;
    up[i] = (SILENCE_MAX_SPEED + (MAX_SPEED - SILENCE_MAX_SPEED) * s - 1) * hopSec;
  }
  return { down, up };
}

/** A forward, a backward and a forward pass: each frame ends within the allowed climb of its neighbour. */
function projectSpeed(lag: Float32Array, steps: SpeedSteps): Float32Array {
  const out = Float32Array.from(lag);
  const { down, up } = steps;
  const forward = () => {
    for (let i = 1; i < out.length; i++) {
      out[i] = Math.min((out[i - 1] as number) + (up[i] as number), Math.max((out[i - 1] as number) + (down[i] as number), out[i] as number));
    }
  };
  forward();
  for (let i = out.length - 2; i >= 0; i--) {
    out[i] = Math.min((out[i + 1] as number) - (down[i + 1] as number), Math.max((out[i + 1] as number) - (up[i + 1] as number), out[i] as number));
  }
  forward();
  return out;
}

/** Moves each pin's value the least it must so it can be reached within the speed bounds from the pin before it. */
function reachablePins(pins: readonly Pin[], steps: SpeedSteps): Pin[] {
  const out: Pin[] = [];
  for (const pin of pins) {
    const previous = out[out.length - 1];
    if (!previous) {
      out.push({ ...pin });
      continue;
    }
    let lowest = previous.value;
    let highest = previous.value;
    for (let i = previous.toFrame + 1; i <= pin.fromFrame; i++) {
      lowest += steps.down[i] as number;
      highest += steps.up[i] as number;
    }
    out.push({ ...pin, value: Math.min(highest, Math.max(lowest, pin.value)) });
  }
  return out;
}

/** The lag values every frame may take if the pins are to be kept and the speed stays within bounds. */
function feasibleRange(frames: number, pins: readonly Pin[], steps: SpeedSteps): { low: Float64Array; high: Float64Array } {
  const { down, up } = steps;
  const lowForward = new Float64Array(frames).fill(-Infinity);
  const highForward = new Float64Array(frames).fill(Infinity);
  const lowBackward = new Float64Array(frames).fill(-Infinity);
  const highBackward = new Float64Array(frames).fill(Infinity);
  const pinned = new Float64Array(frames).fill(Number.NaN);
  for (const pin of pins) pinned.fill(pin.value, pin.fromFrame, pin.toFrame + 1);
  for (let i = 0; i < frames; i++) {
    if (i > 0) {
      lowForward[i] = (lowForward[i - 1] as number) + (down[i] as number);
      highForward[i] = (highForward[i - 1] as number) + (up[i] as number);
    }
    if (!Number.isNaN(pinned[i] as number)) {
      lowForward[i] = pinned[i] as number;
      highForward[i] = pinned[i] as number;
    }
  }
  for (let i = frames - 1; i >= 0; i--) {
    if (i < frames - 1) {
      lowBackward[i] = (lowBackward[i + 1] as number) - (up[i + 1] as number);
      highBackward[i] = (highBackward[i + 1] as number) - (down[i + 1] as number);
    }
    if (!Number.isNaN(pinned[i] as number)) {
      lowBackward[i] = pinned[i] as number;
      highBackward[i] = pinned[i] as number;
    }
  }
  const low = new Float64Array(frames);
  const high = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let lowest = Math.max(lowForward[i] as number, lowBackward[i] as number);
    let highest = Math.min(highForward[i] as number, highBackward[i] as number);
    if (lowest > highest) lowest = highest = (lowest + highest) / 2;
    low[i] = lowest;
    high[i] = highest;
  }
  return { low, high };
}

/**
 * Bends the lag so the speed of the sound stays within bounds (see `speedSteps`) while every pin keeps its value: the
 * speed change a pin asks for is made in the frames before it (and after the pin before it) instead of moving the pin.
 * Without pins this is a plain projection onto the allowed speeds. `sound` is 0..1 per frame (how much the clip sounds).
 */
export function limitSpeed(lag: Float32Array, hopSec: number, sound: Float32Array, pins: readonly Pin[] = []): Float32Array {
  const steps = speedSteps(sound, hopSec);
  const projected = projectSpeed(lag, steps);
  if (pins.length === 0) return projected;
  const reachable = reachablePins(pins, steps);
  const { low, high } = feasibleRange(lag.length, reachable, steps);
  // In double precision: a value that sits exactly on the edge of what the next frame allows must not be pushed
  // over it by rounding, or the clamp below would find an empty range.
  const out = new Float64Array(lag.length);
  for (let i = 0; i < out.length; i++) {
    const previous = i > 0 ? (out[i - 1] as number) : (projected[0] as number);
    const lowest = Math.max(low[i] as number, i > 0 ? previous + (steps.down[i] as number) : -Infinity);
    const highest = Math.min(high[i] as number, i > 0 ? previous + (steps.up[i] as number) : Infinity);
    const wanted = projected[i] as number;
    out[i] = lowest > highest ? (lowest + highest) / 2 : Math.min(highest, Math.max(lowest, wanted));
  }
  return Float32Array.from(out);
}

/** Everything between the raw path and the final lag curve, in the order of the file header. */
export interface ShapedLag {
  lag: Float32Array;
  kept: KeptSpan[];
}

/** Steps 1–5 of the file header on a raw lag. */
export function shapeLag(
  raw: Float32Array,
  weight: Float32Array,
  matched: Float32Array,
  attacks: readonly ClipAttack[],
  tightness: number,
  audible: { fromSec: number; toSec: number },
  hopSec: number,
  sound: Float32Array,
): ShapedLag {
  const settings = tightnessSettings(tightness);
  const smooth = applyDeadZone(smoothLag(raw, weight, settings.smoothSec, hopSec), settings.deadZoneSec);
  return finishLag(smooth, matched, attacks, audible, hopSec, sound);
}

/** Steps 3–5 of the file header on a smoothed lag: fade the ends, keep the attacks, limit the speed. */
export function finishLag(
  smooth: Float32Array,
  matched: Float32Array,
  attacks: readonly ClipAttack[],
  audible: { fromSec: number; toSec: number },
  hopSec: number,
  sound: Float32Array,
  readAfterSec?: number,
): ShapedLag {
  const faded = fadeEdges(smooth, hopSec, audible);
  const { lag, kept, pins } = protectAttacks(faded, matched, attacks, hopSec, readAfterSec);
  return { lag: limitSpeed(lag, hopSec, sound, pins), kept };
}
