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

interface Seg {
  kind: SegKind;
  /** Start time. */
  t: number;
  /** Value at `t`. */
  v0: number;
  /** Ramp end value / target / held value. */
  v: number;
  /** Ramp end time (= t for 'set' and 'target'). */
  end: number;
  tau: number;
}

const identity: Map = (v) => v;
/** Segments that ended this long ago are forgotten. */
const KEEP = 1;
/** Events strictly after a breakpoint are cancelled from this far past it. */
const EPS = 1e-6;

function evalSeg(s: Seg, t: number): number {
  switch (s.kind) {
    case 'set':
      return s.v;
    case 'lin':
      return t >= s.end ? s.v : t <= s.t ? s.v0 : s.v0 + (s.v - s.v0) * ((t - s.t) / (s.end - s.t));
    case 'target':
      return t <= s.t ? s.v0 : s.v + (s.v0 - s.v) * Math.exp(-(t - s.t) / s.tau);
  }
}

export class AutoLane implements AutomatableParam {
  private segs: Seg[] = [];
  private bindings: Binding[] = [];
  private baseValue: number;
  private drivenFlag = false;
  private readonly discrete: boolean;
  readonly automatable: boolean;
  /** See AutomatableParam.shift; set by whoever owns the control when the mixer's compensation changes. */
  shift = 0;

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
    this.segs.push({ kind: 'set', t: 0, v0: initial, v: initial, end: 0, tau: 0 });
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

  /** A document edit at `time`. */
  setBase(value: number, time: number): void {
    this.baseValue = value;
    if (this.drivenFlag) return;
    const t = Math.max(time, this.lastTime());
    if (this.ctx.currentTime === 0 && t === 0) {
      // Before an (offline) render starts: exact, no smoothing.
      this.cancel(0);
      this.segs = [];
      this.push({ kind: 'set', t: 0, v0: value, v: value, end: 0, tau: 0 });
      for (const b of this.bindings) this.schedule(b, 'set', 0, value, 0);
      return;
    }
    // Live edits queue after anything scheduled (only a release ramp, while not driven).
    const at = t;
    if (this.discrete || this.tau <= 0) {
      this.push({ kind: 'set', t: at, v0: value, v: value, end: at, tau: 0 });
      for (const b of this.bindings) this.schedule(b, 'set', at, value, 0);
    } else {
      this.push({ kind: 'target', t: at, v0: this.valueAt(at), v: value, end: at, tau: this.tau });
      for (const b of this.bindings) this.schedule(b, 'target', at, value, this.tau);
    }
  }

  cut(at: number): number {
    const segs = this.segs;
    let i = segs.length - 1;
    while (i > 0 && (segs[i] as Seg).t > at) i--;
    const s = segs[i] as Seg;
    if (s.kind === 'lin' && s.t < at && at < s.end && s.v0 !== s.v) {
      // A ramp is running at `at`: cancelling its end would make the value jump. Keep it, drop what follows.
      for (const b of this.bindings) b.param.cancelScheduledValues(s.end + EPS);
      segs.length = i + 1;
      return s.end;
    }
    // Nothing moves at `at` (a step, a hold, a constant ramp, a setTarget): everything after it can
    // go without the value jumping.
    const v = this.valueAt(at);
    for (let s2 = segs[segs.length - 1] as Seg; segs.length > 1; s2 = segs[segs.length - 1] as Seg) {
      // Ramps and setTargets starting at `at` go too (a linear ramp must not follow a setTarget).
      if (s2.t > at || (s2.t === at && s2.kind !== 'set')) segs.pop();
      else break;
    }
    const last = segs[segs.length - 1] as Seg;
    if (last.end === at && last.kind !== 'target') {
      // An event exactly at `at` (a ramp ending or a step there) already anchors the value.
      for (const b of this.bindings) b.param.cancelScheduledValues(at + EPS);
      return at;
    }
    for (const b of this.bindings) b.param.cancelScheduledValues(at);
    // A constant ramp that ran past `at` lost its end event: it now ends at `at`.
    if (last.kind === 'lin' && last.end > at) last.end = at;
    // Anchor: later ramps start from here (not from the start of whatever held before).
    this.push({ kind: 'set', t: at, v0: v, v, end: at, tau: 0 });
    for (const b of this.bindings) this.schedule(b, 'set', at, v, 0);
    return at;
  }

  start(value: number): void {
    const v = this.clamp(value);
    if (this.ctx.currentTime > 0) {
      // Already rendering: the closest thing is a step at the next opportunity.
      this.cut(this.ctx.currentTime);
      this.extend([this.ctx.currentTime + 1e-4, v]);
      return;
    }
    for (const b of this.bindings) b.param.cancelScheduledValues(0);
    this.segs = [{ kind: 'set', t: 0, v0: v, v, end: 0, tau: 0 }];
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

  extend(points: ArrayLike<number>): void {
    const tail = this.segs[this.segs.length - 1] as Seg;
    // A linear ramp must not follow a running setTarget: anchor it first.
    if (tail.kind === 'target') this.cut(Math.max(this.ctx.currentTime, tail.t));
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
        this.push({ kind: 'set', t, v0: v, v, end: t, tau: 0 });
        for (const b of this.bindings) this.schedule(b, 'set', t, v, 0);
      } else {
        this.push({ kind: 'lin', t: last, v0: before, v, end: t, tau: 0 });
        for (const b of this.bindings) this.schedule(b, 'lin', t, v, 0);
      }
      if (report && v !== before) report(v, t);
    }
    this.trim();
  }

  release(at: number, ramp = 0.02): void {
    const tb = this.cut(at);
    this.extend([tb + Math.max(ramp, 1e-4), this.baseValue]);
    this.drivenFlag = false;
  }

  valueAt(time: number): number {
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i] as Seg;
      if (s.t <= time || i === 0) return evalSeg(s, time);
    }
    return this.baseValue;
  }

  dispose(): void {
    this.bindings = [];
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
    const old = this.ctx.currentTime - KEEP;
    let drop = 0;
    while (drop < this.segs.length - 1 && (this.segs[drop + 1] as Seg).t < old) drop++;
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
        if (s.t >= now) this.schedule(b, 'target', s.t, s.v, s.tau);
        else if (s === this.segs[this.segs.length - 1]) this.schedule(b, 'target', now, s.v, s.tau);
      } else if (s.kind === 'lin') {
        if (s.end > now) this.schedule(b, 'lin', s.end, s.v, 0);
      } else if (s.t > now) this.schedule(b, 'set', s.t, s.v, 0);
    }
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
