/**
 * One target's automation as breakpoints for an AutoLane, in ticks. The breakpoints are the curve's
 * structural ticks (points, clip and loop boundaries, stairs steps) plus an adaptive subdivision of
 * curved segments, so the lane's linear ramps stay within ~0.1 dB / 1 cent of the curve and at most
 * ~25 ms apart. Where the value jumps (a hold or stairs step, a clip starting on another value) the
 * jump becomes a 3 ms ramp; discrete params step exactly where their value changes.
 *
 * Pure and deterministic: the same model and tempo map give the same breakpoints however playback
 * is cut into segments, which is what makes offline renders bit-exact at any chunk size. The
 * driver (driver.ts) turns the ticks into times and feeds the lanes.
 */
import { curveAt, pointBefore, segmentValue, STAIRS_STEPS } from '@core/automation/curve';
import type { AutoSpan, TargetAutomation } from '@core/automation/model';
import type { AutoPoint } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import type { ParamSpec } from '@agstudio/sdk';

/** Longest time between two breakpoints of a moving curve. */
export const MAX_GAP = 0.025;
/** Shortest time between two subdivision breakpoints (caps the error-driven density). */
export const MIN_GAP = 0.001;
/** A jump in the value becomes a ramp this long. */
export const JUMP = 0.003;
/** An endless hold is extended this many ticks at a time. */
const FAR = 7680;
/** Sub-intervals sampled to estimate how densely a curve must be subdivided. */
const PROBES = 16;
/** Most intervals remembered (the playhead and the lookahead only touch a few at a time). */
const CACHE_SIZE = 8;
/** Guard against a plan that never reaches its end: the most iterations of a breakpoint walk. */
const MAX_WALK_STEPS = 1_000_000;
/** A jump smaller than this (relative to the value) is not a jump: it needs no ramp. */
const JUMP_TOLERANCE = 1e-9;
/** A change in a discrete curve is pinned down to this many ticks by bisection... */
const BISECTION_TICKS = 1e-3;
/** ...in at most this many halvings. */
const MAX_BISECTIONS = 48;
/** Tolerances of the ramp error measures (see rampError): dB, and a share of a parameter's range. */
const DB_TOLERANCE = 0.1;
const RANGE_TOLERANCE = 0.002;
/** Safety factor on the subdivision count the error estimate asks for. */
const DENSITY_MARGIN = 1.5;

/**
 * Error of a linear ramp from `a` to `b` at its midpoint against the curve's true value `m` (spec
 * units), in tolerances (≤ 1 is within tolerance).
 */
export type RampError = (a: number, b: number, m: number) => number;

const DB = 20 / Math.LN10;
/** Gains under −60 dB don't count towards the dB error. */
const GAIN_FLOOR = 1e-3;
const gainDb = (a: number, b: number, m: number) =>
  Math.abs(DB * Math.log((Math.max(0, (a + b) / 2) + GAIN_FLOOR) / (Math.max(0, m) + GAIN_FLOOR)));
const dbToGain = (db: number) => Math.pow(10, db / 20);

/**
 * The error measure for a target, in the domain its AudioParams most likely live in: volumes and
 * send levels in dB (0.1 dB), frequencies and other log-scaled params in cents (1 ct), cents and
 * semitones absolutely (1 ct), dB params both in dB and in the gain they are usually bound
 * through (0.1 dB), anything else in 0.2 % of the range. Discrete params never ramp.
 */
export function rampError(key: string, spec: ParamSpec): RampError {
  if (spec.type !== 'float') return () => 0;
  if (/^(ch:[^:]+:volume|ins:[^:]+:volume|route:)/.test(key)) return (a, b, m) => gainDb(a, b, m) / DB_TOLERANCE;
  if (spec.unit === 'Hz' || (spec.scale === 'log' && spec.min > 0))
    return (a, b, m) => (m > 0 && a + b > 0 ? Math.abs(1200 * Math.log2((a + b) / 2 / m)) : 0);
  if (spec.unit === 'ct') return (a, b, m) => Math.abs((a + b) / 2 - m);
  if (spec.unit === 'st') return (a, b, m) => Math.abs((a + b) / 2 - m) * 100;
  if (spec.unit === 'dB' || spec.scale === 'db')
    return (a, b, m) => Math.max(Math.abs((a + b) / 2 - m), gainDb(dbToGain(a), dbToGain(b), dbToGain(m))) / DB_TOLERANCE;
  const range = spec.max - spec.min || 1;
  return (a, b, m) => Math.abs((a + b) / 2 - m) / (range * RANGE_TOLERANCE);
}

/** A stretch of the song timeline governed by one span (or by none: the document value). */
interface Piece {
  start: number;
  end: number;
  span: AutoSpan | null;
  /** Inside the span (its curve) rather than after it (holding its last value). */
  inside: boolean;
}

/** Where the value follows one formula: a constant, or one curve segment between two points. */
export interface Interval {
  readonly start: number;
  readonly end: number;
  /** The value (spec units) of a constant interval; NaN for a curve. */
  readonly value: number;
  /** Curves: the segment's points and the song tick of content tick 0. */
  readonly a: AutoPoint | null;
  readonly b: AutoPoint | null;
  readonly origin: number;
  /** Curves: equal subdivisions of [start, end) (0 until first used). */
  steps: number;
}

/** Spans governing the timeline, by the rules of automationAt (latest-starting span wins, holds after). */
function piecesOf(spans: readonly AutoSpan[]): Piece[] {
  const cuts = new Set<number>([0]);
  for (const s of spans) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  const ticks = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const start = ticks[i] as number;
    const end = i + 1 < ticks.length ? (ticks[i + 1] as number) : Infinity;
    let inside: AutoSpan | null = null;
    let ended: AutoSpan | null = null;
    for (const s of spans) {
      if (s.start > start) break;
      if (start < s.end) inside = s;
      else if (!ended || s.end >= ended.end) ended = s;
    }
    const span = inside ?? ended;
    const last = out[out.length - 1];
    if (last && last.span === span && last.inside === !!inside) last.end = end;
    else out.push({ start, end, span, inside: !!inside });
  }
  return out;
}

/** Index of the last point strictly before content tick `c` (−1 when none). */
function pointStrictlyBefore(points: readonly AutoPoint[], c: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((points[mid] as AutoPoint).tick < c) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const constant = (start: number, end: number, value: number): Interval => ({
  start,
  end,
  value,
  a: null,
  b: null,
  origin: 0,
  steps: 0,
});

export class CurvePlanner {
  private readonly pieces: Piece[];
  private readonly cache: Interval[] = [];
  private tempo: TempoMap;
  /** Discrete params: the value after the last change written by discreteBreakpoints. */
  lastValue = Number.NaN;
  /** The tick the last *Breakpoints call got to (the frontier to continue from). */
  reached = 0;

  constructor(
    readonly automation: TargetAutomation,
    /** Normalized curve value → spec units (resolveTarget's fromNormalized). */
    private readonly map: (n: number) => number,
    /** The document value (before the target's first clip). */
    private readonly base: number,
    readonly discrete: boolean,
    private readonly error: RampError,
    tempo: TempoMap,
  ) {
    this.pieces = piecesOf(automation.spans);
    this.tempo = tempo;
  }

  /** The tempo changed: subdivisions (25 ms) and jump lengths follow it. */
  setTempo(tempo: TempoMap): void {
    if (tempo === this.tempo) return;
    this.tempo = tempo;
    this.cache.length = 0;
  }

  /** The value at a song tick (the interval starting there, at boundaries). */
  valueAt(tick: number): number {
    return this.valueIn(this.intervalAt(tick), tick);
  }

  /** The value approaching a song tick from before (the interval ending there, at boundaries). */
  valueBefore(tick: number): number {
    return this.valueIn(this.intervalBefore(tick), tick);
  }

  /** The interval [start, end) containing `tick`. */
  intervalAt(tick: number): Interval {
    for (const interval of this.cache) if (interval.start <= tick && tick < interval.end) return interval;
    return this.remember(this.compute(tick, false));
  }

  /** The interval (start, end] containing `tick` (the one that ends at a boundary). */
  intervalBefore(tick: number): Interval {
    for (const interval of this.cache) if (interval.start < tick && tick <= interval.end) return interval;
    return this.remember(this.compute(tick, true));
  }

  /**
   * Continuous params: writes (tick, value) pairs after `from` into `out`, through the first
   * breakpoint at or after `through`, never past `end` (the loop end: the value there is the one
   * arriving from before). Returns the number of pairs; `reached` is the last tick written (call
   * again from there when `out` filled up).
   */
  floatBreakpoints(from: number, through: number, end: number, out: Float64Array): number {
    const max = out.length >> 1;
    let count = 0;
    let tick = from;
    for (let guard = 0; guard < MAX_WALK_STEPS && tick < through && tick < end && count + 2 <= max; guard++) {
      const interval = this.intervalAt(tick);
      let next: number;
      let value: number;
      if (Number.isNaN(interval.value)) {
        next = Math.min(this.nextGrid(interval, tick), end);
        value = this.valueIn(interval, next);
      } else {
        next = Math.min(interval.end, end);
        // An endless hold: extend it a little at a time.
        if (!Number.isFinite(next)) next = Math.max(tick, through) + FAR;
        value = interval.value;
      }
      out[2 * count] = next;
      out[2 * count + 1] = value;
      count++;
      tick = next;
      if (tick === interval.end && tick < end) {
        // A structural boundary: if the value jumps here, ramp over JUMP instead.
        const jumpEnd = this.jumpRampEnd(tick, value, end);
        if (jumpEnd !== null) {
          out[2 * count] = jumpEnd.tick;
          out[2 * count + 1] = jumpEnd.value;
          count++;
          tick = jumpEnd.tick;
        }
      }
    }
    this.reached = tick;
    return count;
  }

  /**
   * Where the ramp over a jump ends, when the value jumps at the boundary `tick` from `valueBefore`: JUMP seconds on,
   * but not past the next interval or `end`. Null when the value does not jump (or there is no room for a ramp).
   */
  private jumpRampEnd(tick: number, valueBefore: number, end: number): { tick: number; value: number } | null {
    const after = this.intervalAt(tick);
    const valueAfter = this.valueIn(after, tick);
    if (!(Math.abs(valueAfter - valueBefore) > JUMP_TOLERANCE * (1 + Math.abs(valueBefore)))) return null;
    const rampEnd = Math.min(this.tempo.secondsToTick(this.tempo.tickToSeconds(tick) + JUMP), after.end, end);
    if (rampEnd <= tick) return null;
    return { tick: rampEnd, value: this.valueIn(after, rampEnd) };
  }

  /**
   * Discrete params: writes (tick, value) pairs for every change in (from, through] (changes at
   * exactly `end` belong to the next pass of the loop). `current` is the value before `from`;
   * `lastValue` is the value after the last change and `reached` how far it looked.
   */
  discreteBreakpoints(from: number, through: number, end: number, current: number, out: Float64Array): number {
    const max = out.length >> 1;
    const until = Math.min(through, end);
    const inclusive = until < end;
    let count = 0;
    let tick = from;
    let currentValue = current;
    const push = (at: number, value: number) => {
      out[2 * count] = at;
      out[2 * count + 1] = value;
      count++;
      currentValue = value;
    };
    for (let guard = 0; guard < MAX_WALK_STEPS && tick < until && count < max; guard++) {
      const interval = this.intervalAt(tick);
      if (Number.isNaN(interval.value)) {
        const stop = Math.min(interval.end, until);
        const changedAt = this.firstChange(interval, tick, stop, currentValue);
        if (changedAt >= 0) {
          push(changedAt, this.valueIn(interval, changedAt));
          tick = changedAt;
          continue;
        }
        tick = stop;
      } else {
        if (interval.end > until || (interval.end === until && !inclusive)) {
          tick = until;
          break;
        }
        tick = interval.end;
      }
      if (tick === interval.end && (tick < until || inclusive)) {
        const value = this.valueAt(tick);
        if (value !== currentValue) push(tick, value);
      }
    }
    if (count >= max) this.reached = tick;
    else this.reached = Math.max(tick, until);
    this.lastValue = currentValue;
    return count;
  }

  /**
   * The first tick in [from, stop) where a curve interval's value differs from `current`, or −1. Looks on a ~25 ms
   * grid for a change, then pins it down by bisection.
   */
  private firstChange(interval: Interval, from: number, stop: number, current: number): number {
    let low = from;
    while (low < stop) {
      const gridTick = Math.min(this.nextGrid(interval, low), stop);
      if (this.valueIn(interval, gridTick) !== current) {
        let high = gridTick;
        for (let k = 0; k < MAX_BISECTIONS && high - low > BISECTION_TICKS; k++) {
          const middle = (low + high) / 2;
          if (this.valueIn(interval, middle) !== current) high = middle;
          else low = middle;
        }
        return high;
      }
      low = gridTick;
    }
    return -1;
  }

  private remember(interval: Interval): Interval {
    this.cache.push(interval);
    if (this.cache.length > CACHE_SIZE) this.cache.shift();
    return interval;
  }

  private valueIn(interval: Interval, tick: number): number {
    if (!Number.isNaN(interval.value)) return interval.value;
    return this.map(segmentValue(interval.a as AutoPoint, interval.b as AutoPoint, tick - interval.origin));
  }

  /** The first subdivision tick of a curve interval after `t` (its end at the latest). */
  private nextGrid(interval: Interval, t: number): number {
    const n = this.steps(interval);
    const span = interval.end - interval.start;
    let k = Math.max(1, Math.floor(((t - interval.start) / span) * n) + 1);
    const at = (i: number) => (i >= n ? interval.end : interval.start + (span * i) / n);
    let g = at(k);
    while (g <= t && k < n) g = at(++k);
    return g > t ? g : interval.end;
  }

  /** Subdivisions of a curve interval: ≤ 25 ms apart, dense enough for the error target, ≥ 1 ms. */
  private steps(interval: Interval): number {
    if (interval.steps > 0) return interval.steps;
    const secs = Math.max(0, this.tempo.tickToSeconds(interval.end) - this.tempo.tickToSeconds(interval.start));
    const byTime = Math.ceil(secs / MAX_GAP - 1e-9);
    let worst = 0;
    if (!this.discrete) {
      const span = interval.end - interval.start;
      let prev = this.valueIn(interval, interval.start);
      for (let k = 1; k <= PROBES; k++) {
        const next = this.valueIn(interval, k === PROBES ? interval.end : interval.start + (span * k) / PROBES);
        const mid = this.valueIn(interval, interval.start + (span * (k - 0.5)) / PROBES);
        worst = Math.max(worst, this.error(prev, next, mid));
        prev = next;
      }
    }
    // A ramp's error shrinks with the square of its length.
    const byError = Number.isFinite(worst) ? Math.ceil(PROBES * Math.sqrt(worst) * DENSITY_MARGIN) : Infinity;
    const cap = Math.max(1, Math.floor(Math.min(secs / MIN_GAP, interval.end - interval.start)));
    interval.steps = Math.max(1, Math.min(cap, Math.max(byTime, byError)));
    return interval.steps;
  }

  /** The piece containing `tick` ([start, end), or (start, end] when `left`). */
  private pieceAt(tick: number, left: boolean): Piece {
    const ps = this.pieces;
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const s = (ps[mid] as Piece).start;
      if (left ? s < tick : s <= tick) lo = mid;
      else hi = mid - 1;
    }
    return ps[lo] as Piece;
  }

  private compute(tick: number, left: boolean): Interval {
    const piece = this.pieceAt(tick, left);
    const span = piece.span;
    if (!span) return constant(piece.start, piece.end, this.base);
    const pts = span.points;
    if (!piece.inside) {
      const held = curveAt(pts, span.end - span.start + span.offset) ?? 0;
      return constant(piece.start, piece.end, this.map(held));
    }
    const origin = span.start - span.offset;
    const c = tick - origin;
    const i = left ? pointStrictlyBefore(pts, c) : pointBefore(pts, c);
    const clip = (s: number, e: number) => [Math.max(s, piece.start), Math.min(e, piece.end)] as const;
    if (i < 0) {
      const [s, e] = clip(-Infinity, origin + (pts[0] as AutoPoint).tick);
      return constant(s, e, this.map((pts[0] as AutoPoint).value));
    }
    const a = pts[i] as AutoPoint;
    if (i >= pts.length - 1) {
      const [s, e] = clip(origin + a.tick, Infinity);
      return constant(s, e, this.map(a.value));
    }
    const b = pts[i + 1] as AutoPoint;
    const segStart = origin + a.tick;
    const segEnd = origin + b.tick;
    switch (a.shape ?? 'curve') {
      case 'hold': {
        const [s, e] = clip(segStart, segEnd);
        return constant(s, e, this.map(a.value));
      }
      case 'stairs': {
        const at = (k: number) => (k >= STAIRS_STEPS ? segEnd : segStart + ((segEnd - segStart) * k) / STAIRS_STEPS);
        let k = 0;
        while (k + 1 < STAIRS_STEPS && (left ? at(k + 1) < tick : at(k + 1) <= tick)) k++;
        const [s, e] = clip(at(k), at(k + 1));
        return constant(s, e, this.map(a.value + ((b.value - a.value) * k) / STAIRS_STEPS));
      }
      case 'smooth':
      case 'curve': {
        const [s, e] = clip(segStart, segEnd);
        if (a.value === b.value) return constant(s, e, this.map(a.value));
        return { start: s, end: e, value: Number.NaN, a, b, origin, steps: 0 };
      }
    }
  }
}
