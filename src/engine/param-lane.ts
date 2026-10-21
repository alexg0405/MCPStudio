/**
 * The one writer of an automatable value. Every change to a channel's or insert's volume and pan, or
 * to a plugin param, goes through its lane: live edits (smoothed), the automation driver's ramps,
 * and replays onto AudioParams bound later (voices, async plugins, engine reboots). The lane models
 * what it scheduled (in spec units, before each binding's map), so it can answer `valueAt(t)` and
 * cut its schedule without the value ever jumping:
 *
 * - live edits while nothing drives it: `setTargetAtTime` towards the new value (steps for discrete
 *   params, and exact `setValueAtTime(v, 0)` before an offline render starts);
 * - `cut(at)` keeps a ramp that is running at `at` (up to its end) and cancels the rest; where nothing
 *   moves at `at` (a step, a hold, a constant ramp, a setTarget) it cancels from `at` on and anchors the
 *   value there. `extend` appends linear ramps (steps for discrete params);
 * - `release` hands the value back to its base (the document value) with a short ramp.
 *
 * - `follow(source, map)` makes the lane a copy of another lane seen through a function: every value the source has or
 *   schedules reaches this lane's AudioParams mapped (a macro knob driving a parameter inside an effect rack). While it
 *   follows, automation and document edits leave the value alone.
 *
 * It never writes `.value` (offline renders must be exact), never uses value curves, exponential
 * ramps or cancelAndHold, and keeps event times strictly increasing.
 */
import { isAutomatable, type ParamSpec } from '@agstudio/sdk';

/** What the automation driver, MIDI links and knobs that follow automation work with. */
export interface AutomatableParam {
  /** `targetKey()` of what it controls (several params may share a key while an instance is replaced). */
  readonly key: string;
  readonly spec: ParamSpec;
  /** The document value (numeric encoding: enum → index, bool → 0/1). */
  readonly base: number;
  /**
   * Seconds the control sits behind the song's clock: what it controls is heard that long after the time the
   * transport schedules (the mixer's delay compensation holds things back). The automation driver works in the
   * song's time and moves everything it writes to the lane by this much (`ShiftedParam`).
   */
  readonly shift?: number;
  /** True while automation owns the value (live edits then only change `base`). */
  readonly driven: boolean;
  /**
   * Keeps the schedule up to `at` (a ramp running at `at` is kept up to its end) and drops the rest.
   * Returns the time the schedule now ends at (`at`, or that ramp's end): append from there with `extend`.
   */
  cut(at: number): number;
  /** Takes the value over and appends (time, value) pairs, strictly after the last cut, in spec units. */
  extend(points: ArrayLike<number>): void;
  /** Gives the value back to `base`, ramping over `ramp` seconds from the next breakpoint at or after `at`. */
  release(at: number, ramp?: number): void;
  /** The value the lane has at `time` (spec units, numeric encoding). */
  valueAt(time: number): number;
  /** Time of the last scheduled event (the value holds after it). */
  readonly scheduledUntil: number;
  /**
   * Before a render starts (context time 0): takes the value over at exactly `value` from time 0,
   * with no ramp (offline renders start exact).
   */
  start(value: number): void;
}

type Map = (v: number) => number;

interface Binding {
  param: AudioParam;
  map: Map;
}

type SegKind = 'set' | 'lin' | 'target';

/** One scheduled event of the lane, as it models it: a step, a linear ramp or an exponential approach. */
interface Seg {
  kind: SegKind;
  /** Start time. */
  time: number;
  /** Value at `time`. */
  fromValue: number;
  /** Ramp end value / target / held value. */
  value: number;
  /** Ramp end time (= time for 'set' and 'target'). */
  end: number;
  /** Time constant of a 'target' approach (seconds). */
  tau: number;
}

const identity: Map = (v) => v;
/** Segments that ended this long ago (seconds) are forgotten. */
const KEEP_SEGMENTS_SEC = 1;
/** Events strictly after a breakpoint are cancelled from this far past it (seconds). */
const CANCEL_EPSILON_SEC = 1e-6;
/** The shortest ramp a release or a restart uses (seconds): a step in all but name. */
const MIN_RAMP_SEC = 1e-4;
/** The ramp a release takes back to the document value, when the caller gives none (seconds). */
const DEFAULT_RELEASE_RAMP_SEC = 0.02;

/** The value a segment gives at `time` (before its start it is what it started from). */
function evalSeg(seg: Seg, time: number): number {
  switch (seg.kind) {
    case 'set':
      return seg.value;
    case 'lin':
      if (time >= seg.end) return seg.value;
      if (time <= seg.time) return seg.fromValue;
      return seg.fromValue + (seg.value - seg.fromValue) * ((time - seg.time) / (seg.end - seg.time));
    case 'target':
      if (time <= seg.time) return seg.fromValue;
      return seg.value + (seg.fromValue - seg.value) * Math.exp(-(time - seg.time) / seg.tau);
  }
}

/** The single writer of an automatable value: it holds the base value and the scheduled breakpoints and drives every AudioParam bound to it. */
export class AutoLane implements AutomatableParam {
  private segs: Seg[] = [];
  private bindings: Binding[] = [];
  private baseValue: number;
  private drivenFlag = false;
  private readonly discrete: boolean;
  readonly automatable: boolean;
  /** See AutomatableParam.shift; set by whoever owns the control when the mixer's compensation changes. */
  shift = 0;
  /** Stops listening to the lane this one follows (null while it follows none). */
  private stopFollowing: ((release?: boolean) => void) | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly key: string,
    readonly spec: ParamSpec,
    initial: number,
    /** Time constant of live edits (0 = steps). */
    private readonly tau: number,
  ) {
    this.discrete = spec.type !== 'float';
    this.automatable = isAutomatable(spec);
    this.baseValue = initial;
    this.segs.push({ kind: 'set', time: 0, fromValue: initial, value: initial, end: 0, tau: 0 });
  }

  get base(): number {
    return this.baseValue;
  }

  get driven(): boolean {
    return this.drivenFlag;
  }

  /** Drives `param` (its own value should be the map of the lane's value); replays the schedule. */
  bind(param: AudioParam, map: Map = identity): () => void {
    const b: Binding = { param, map };
    this.bindings.push(b);
    this.replay(b);
    return () => {
      this.bindings = this.bindings.filter((x) => x !== b);
    };
  }

  /** A document edit at `time`. `glideTau` replaces the lane's time constant for this edit (a snapshot recall glides slower). */
  setBase(value: number, time: number, glideTau: number = this.tau): void {
    this.baseValue = value;
    if (this.drivenFlag) return;
    const t = Math.max(time, this.lastTime());
    if (this.ctx.currentTime === 0 && t === 0) {
      // Before an (offline) render starts: exact, no smoothing.
      this.cancel(0);
      this.segs = [];
      this.push({ kind: 'set', time: 0, fromValue: value, value, end: 0, tau: 0 });
      for (const b of this.bindings) this.schedule(b, 'set', 0, value, 0);
      return;
    }
    // Live edits queue after anything scheduled (only a release ramp, while not driven).
    const at = t;
    if (this.discrete || glideTau <= 0) {
      this.push({ kind: 'set', time: at, fromValue: value, value, end: at, tau: 0 });
      for (const b of this.bindings) this.schedule(b, 'set', at, value, 0);
    } else {
      this.push({ kind: 'target', time: at, fromValue: this.valueAt(at), value, end: at, tau: glideTau });
      for (const b of this.bindings) this.schedule(b, 'target', at, value, glideTau);
    }
  }

  cut(at: number): number {
    if (this.stopFollowing) return at;
    const segs = this.segs;
    let i = segs.length - 1;
    while (i > 0 && (segs[i] as Seg).time > at) i--;
    const s = segs[i] as Seg;
    if (s.kind === 'lin' && s.time < at && at < s.end && s.fromValue !== s.value) {
      // A ramp is running at `at`: cancelling its end would make the value jump. Keep it, drop what follows.
      for (const b of this.bindings) b.param.cancelScheduledValues(s.end + CANCEL_EPSILON_SEC);
      segs.length = i + 1;
      return s.end;
    }
    // Nothing moves at `at` (a step, a hold, a constant ramp, a setTarget): everything after it can
    // go without the value jumping.
    const v = this.valueAt(at);
    for (let s2 = segs[segs.length - 1] as Seg; segs.length > 1; s2 = segs[segs.length - 1] as Seg) {
      // Ramps and setTargets starting at `at` go too (a linear ramp must not follow a setTarget).
      if (s2.time > at || (s2.time === at && s2.kind !== 'set')) segs.pop();
      else break;
    }
    const last = segs[segs.length - 1] as Seg;
    if (last.end === at && last.kind !== 'target') {
      // An event exactly at `at` (a ramp ending or a step there) already anchors the value.
      for (const b of this.bindings) b.param.cancelScheduledValues(at + CANCEL_EPSILON_SEC);
      return at;
    }
    for (const b of this.bindings) b.param.cancelScheduledValues(at);
    // A constant ramp that ran past `at` lost its end event: it now ends at `at`.
    if (last.kind === 'lin' && last.end > at) last.end = at;
    // Anchor: later ramps start from here (not from the start of whatever held before).
    this.push({ kind: 'set', time: at, fromValue: v, value: v, end: at, tau: 0 });
    for (const b of this.bindings) this.schedule(b, 'set', at, v, 0);
    return at;
  }

  start(value: number): void {
    if (this.stopFollowing) return;
    const v = this.clamp(value);
    if (this.ctx.currentTime > 0) {
      // Already rendering: the closest thing is a step at the next opportunity.
      this.cut(this.ctx.currentTime);
      this.extend([this.ctx.currentTime + MIN_RAMP_SEC, v]);
      return;
    }
    if (!this.drivenFlag) this.onFirstDrive?.();
    for (const b of this.bindings) b.param.cancelScheduledValues(0);
    this.segs = [{ kind: 'set', time: 0, fromValue: v, value: v, end: 0, tau: 0 }];
    for (const b of this.bindings) this.schedule(b, 'set', 0, v, 0);
    this.drivenFlag = true;
    this.onScheduled?.(v, 0);
  }

  get scheduledUntil(): number {
    return this.lastTime();
  }

  /** Segments the lane remembers (they are trimmed to about a second behind the clock). */
  get segmentCount(): number {
    return this.segs.length;
  }

  /** Told about every value change the lane schedules for automation (onChange-only plugin params). */
  onScheduled?: (value: number, time: number) => void;

  /**
   * Called just before automation takes the value over for the first time, so whoever owns the control can bind the
   * AudioParams it had left out while nothing moved them (an unbound lane only keeps its model).
   */
  onFirstDrive?: () => void;

  extend(points: ArrayLike<number>): void {
    if (this.stopFollowing) return;
    if (!this.drivenFlag) this.onFirstDrive?.();
    const tail = this.segs[this.segs.length - 1] as Seg;
    // A linear ramp must not follow a running setTarget: anchor it first.
    if (tail.kind === 'target') this.cut(Math.max(this.ctx.currentTime, tail.time));
    this.drivenFlag = true;
    const report = this.onScheduled;
    for (let i = 0; i + 1 < points.length; i += 2) {
      const t = points[i] as number;
      const raw = points[i + 1] as number;
      const last = this.lastTime();
      if (!(t > last) || !Number.isFinite(t) || !Number.isFinite(raw)) continue;
      const v = this.clamp(raw);
      const before = this.valueAt(last);
      if (this.discrete) {
        this.push({ kind: 'set', time: t, fromValue: v, value: v, end: t, tau: 0 });
        for (const b of this.bindings) this.schedule(b, 'set', t, v, 0);
      } else {
        this.push({ kind: 'lin', time: last, fromValue: before, value: v, end: t, tau: 0 });
        for (const b of this.bindings) this.schedule(b, 'lin', t, v, 0);
      }
      if (report && v !== before) report(v, t);
    }
    this.trim();
  }

  release(at: number, ramp = DEFAULT_RELEASE_RAMP_SEC): void {
    if (this.stopFollowing) return;
    const tb = this.cut(at);
    this.extend([tb + Math.max(ramp, MIN_RAMP_SEC), this.baseValue]);
    this.drivenFlag = false;
  }

  valueAt(time: number): number {
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i] as Seg;
      if (s.time <= time || i === 0) return evalSeg(s, time);
    }
    return this.baseValue;
  }

  dispose(): void {
    this.stopFollowing?.(false);
    this.stopFollowing = null;
    this.bindings = [];
  }

  /** True while the lane is a copy of another lane (see `follow`). */
  get following(): boolean {
    return this.stopFollowing !== null;
  }

  /**
   * Makes this lane follow `source`: the source's value now, and everything it schedules later, reaches this lane's
   * AudioParams through `map` (source units to this lane's units). Automation and document edits leave the value alone
   * until the returned function is called, which gives the value back to the document's (with a short ramp, or at once
   * when `release` is false: a lane that is going away).
   *
   * `bent` says that `map` is not a straight line, so a long linear ramp of the source is cut into short pieces that
   * follow the bend (a frequency sweep stays even in octaves).
   */
  follow(source: AutoLane, map: (value: number) => number, options: { bent: boolean }): (release?: boolean) => void {
    this.stopFollowing?.(false);
    if (!this.drivenFlag) this.onFirstDrive?.();
    // The lane's own schedule goes: from here on it is a copy of the source's.
    this.cancel(0);
    this.segs = [{ kind: 'set', time: 0, fromValue: this.baseValue, value: this.baseValue, end: 0, tau: 0 }];
    this.drivenFlag = true;
    const relay = new LaneRelay(this, source.base, map, options.bent);
    const unbind = source.bind(relay as unknown as AudioParam);
    let isActive = true;
    const stop = (release = true): void => {
      if (!isActive) return;
      isActive = false;
      unbind();
      if (this.stopFollowing === stop) this.stopFollowing = null;
      if (release && this.stopFollowing === null) this.release(this.ctx.currentTime);
    };
    this.stopFollowing = stop;
    return stop;
  }

  /**
   * One scheduled value of the lane being followed, already mapped into this lane's units (called by the LaneRelay).
   * It is scheduled and remembered exactly as the lane would its own.
   */
  mirror(kind: SegKind, time: number, raw: number, tau = 0): void {
    if (!Number.isFinite(raw) || !Number.isFinite(time)) return;
    const v = this.clamp(raw);
    const last = this.lastTime();
    const before = this.valueAt(kind === 'lin' ? last : time);
    // A ramp that does not end after the last event, or any ramp of a stepped parameter, is a step.
    const asKind: SegKind = kind === 'lin' && (this.discrete || !(time > last)) ? 'set' : kind;
    if (asKind === 'lin') this.push({ kind: 'lin', time: last, fromValue: before, value: v, end: time, tau: 0 });
    else if (asKind === 'set') this.push({ kind: 'set', time, fromValue: v, value: v, end: time, tau: 0 });
    else this.push({ kind: 'target', time, fromValue: before, value: v, end: time, tau });
    for (const b of this.bindings) this.schedule(b, asKind, time, v, asKind === 'target' ? tau : 0);
    if (v !== before) this.onScheduled?.(v, time);
  }

  /** The lane being followed cancelled what it had scheduled from `time` on (called by the LaneRelay). */
  mirrorCancel(time: number): void {
    for (const b of this.bindings) b.param.cancelScheduledValues(time);
    const segs = this.segs;
    while (segs.length > 1) {
      const tail = segs[segs.length - 1] as Seg;
      // A ramp is an event at its end (as it is to an AudioParam): a ramp that ends from `time` on goes whole.
      const eventTime = tail.kind === 'lin' ? tail.end : tail.time;
      if (eventTime < time) break;
      segs.pop();
    }
  }

  /** Time of the latest scheduled event. */
  private lastTime(): number {
    const s = this.segs[this.segs.length - 1] as Seg;
    return s.end;
  }

  private cancel(t: number): void {
    for (const b of this.bindings) b.param.cancelScheduledValues(t);
  }

  private push(seg: Seg): void {
    this.segs.push(seg);
    this.trim();
  }

  /** Forgets segments that ended long ago (keeps the one in effect then). */
  private trim(): void {
    const old = this.ctx.currentTime - KEEP_SEGMENTS_SEC;
    let drop = 0;
    while (drop < this.segs.length - 1 && (this.segs[drop + 1] as Seg).time < old) drop++;
    if (drop > 0) this.segs.splice(0, drop);
  }

  private clamp(v: number): number {
    const s = this.spec;
    if (s.type === 'float' || s.type === 'int') return Math.min(s.max, Math.max(s.min, v));
    if (s.type === 'enum') return Math.min(s.options.length - 1, Math.max(0, Math.round(v)));
    return v >= 0.5 ? 1 : 0;
  }

  private mapped(b: Binding, v: number): number | null {
    const m = b.map(v);
    return Number.isFinite(m) ? m : null;
  }

  private schedule(b: Binding, kind: SegKind, t: number, v: number, tau: number): void {
    const m = this.mapped(b, v);
    if (m === null) return;
    if (kind === 'set') b.param.setValueAtTime(m, t);
    else if (kind === 'lin') b.param.linearRampToValueAtTime(m, t);
    else b.param.setTargetAtTime(m, t, tau);
  }

  /** Brings a newly bound param in line with the lane: the value now, then everything after. */
  private replay(b: Binding): void {
    const now = this.ctx.currentTime;
    const v = this.mapped(b, this.valueAt(now));
    if (v !== null) b.param.setValueAtTime(v, now);
    for (const s of this.segs) {
      if (s.kind === 'target') {
        if (s.time >= now) this.schedule(b, 'target', s.time, s.value, s.tau);
        else if (s === this.segs[this.segs.length - 1]) this.schedule(b, 'target', now, s.value, s.tau);
      } else if (s.kind === 'lin') {
        if (s.end > now) this.schedule(b, 'lin', s.end, s.value, 0);
      } else if (s.time > now) this.schedule(b, 'set', s.time, s.value, 0);
    }
  }
}

/** A followed linear ramp is cut into pieces about this long (seconds) when the map bends. */
const RAMP_PIECE_SEC = 0.02;
/** The most pieces one ramp is cut into: a very long sweep gets longer pieces rather than thousands of events. */
const MAX_RAMP_PIECES = 64;

/**
 * The AudioParam a followed lane writes to: it hands every event to the lane that follows (`AutoLane.follow`), mapped
 * into the follower's units. It keeps the source's own values so a long ramp can be cut into pieces that follow a bent map.
 */
class LaneRelay {
  /** The events of the source as an AudioParam would hold them, in the source's units. */
  private events: { time: number; value: number }[] = [];

  constructor(
    private readonly follower: AutoLane,
    private readonly initial: number,
    private readonly map: (value: number) => number,
    private readonly bent: boolean,
  ) {}

  setValueAtTime(value: number, time: number): this {
    this.events.push({ time, value });
    this.follower.mirror('set', time, this.map(value));
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    const from = this.events[this.events.length - 1] ?? { time, value: this.initial };
    this.events.push({ time, value });
    const pieces = this.bent ? Math.min(MAX_RAMP_PIECES, Math.max(1, Math.ceil((time - from.time) / RAMP_PIECE_SEC))) : 1;
    for (let i = 1; i <= pieces; i++) {
      const at = i === pieces ? time : from.time + ((time - from.time) * i) / pieces;
      const along = i === pieces ? value : from.value + ((value - from.value) * i) / pieces;
      this.follower.mirror('lin', at, this.map(along));
    }
    return this;
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    this.events.push({ time, value });
    this.follower.mirror('target', time, this.map(value), tau);
    return this;
  }

  cancelScheduledValues(time: number): this {
    while (this.events.length > 0 && (this.events[this.events.length - 1] as { time: number }).time >= time) this.events.pop();
    this.follower.mirrorCancel(time);
    return this;
  }
}

/** Every automatable param, by target key (several per key while an instance is being replaced). */
export class ParamRegistry {
  private readonly byKey = new Map<string, Set<AutomatableParam>>();
  /** The newest param of each key, kept up to date on register and unregister (read every frame). */
  private readonly newestByKey = new Map<string, AutomatableParam>();
  private readonly listeners = new Set<(p: AutomatableParam, added: boolean) => void>();

  register(p: AutomatableParam): () => void {
    let set = this.byKey.get(p.key);
    if (!set) this.byKey.set(p.key, (set = new Set()));
    // A param already in the set keeps its place, so the newest stays as it was.
    if (!set.has(p)) this.newestByKey.set(p.key, p);
    set.add(p);
    for (const fn of this.listeners) fn(p, true);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = this.byKey.get(p.key);
      s?.delete(p);
      if (s && s.size === 0) {
        this.byKey.delete(p.key);
        this.newestByKey.delete(p.key);
      } else if (s && this.newestByKey.get(p.key) === p) {
        // The newest went away: the one before it (rare, so the walk over the set is fine here).
        let last: AutomatableParam | undefined;
        for (const q of s) last = q;
        if (last) this.newestByKey.set(p.key, last);
      }
      for (const fn of this.listeners) fn(p, false);
    };
  }

  /** Called after a param registers (`added`) or unregisters (the automation driver picks new ones up). */
  subscribe(fn: (p: AutomatableParam, added: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** All params registered under `key` (newest last). */
  get(key: string): readonly AutomatableParam[] {
    const s = this.byKey.get(key);
    return s ? [...s] : [];
  }

  /** The most recently registered param under `key` (no allocation: read from `newestByKey`). */
  newest(key: string): AutomatableParam | undefined {
    return this.newestByKey.get(key);
  }

  /** Calls `fn` for every param under `key` (no allocation). */
  forEach(key: string, fn: (p: AutomatableParam) => void): void {
    const s = this.byKey.get(key);
    if (s) for (const p of s) fn(p);
  }

  keys(): IterableIterator<string> {
    return this.byKey.keys();
  }
}
