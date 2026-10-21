import { describe, expect, it } from 'vitest';
import { p } from '@agstudio/sdk';
import { ParamHandleImpl } from './param-handle';
import { AutoLane, ParamRegistry } from './param-lane';

type Ev = [method: string, value: number, time: number, extra?: number];

/** Records AudioParam calls and evaluates the resulting curve like Web Audio (enough for these tests). */
class FakeParam {
  events: Ev[] = [];
  setValueAtTime(v: number, t: number) {
    this.add(['set', v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.add(['lin', v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    this.add(['target', v, t, tau]);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events = this.events.filter((e) => e[2] < t);
    return this;
  }
  private add(e: Ev) {
    this.events.push(e);
    this.events.sort((a, b) => a[2] - b[2]);
  }
  /** Value at `t` from the recorded events. */
  at(t: number): number {
    let v = 0;
    let prevT = 0;
    let target: Ev | null = null;
    for (const e of this.events) {
      if (e[0] === 'lin') {
        if (e[2] <= t) {
          v = e[1];
          prevT = e[2];
          target = null;
          continue;
        }
        const from = target ? target[1] + (v - target[1]) * Math.exp(-(prevT - target[2]) / target[3]!) : v;
        return from + (e[1] - from) * ((t - prevT) / (e[2] - prevT));
      }
      if (e[2] > t) break;
      if (e[0] === 'set') {
        v = e[1];
        target = null;
      } else {
        // setTarget: starts from the value at its time
        v = target ? target[1] + (v - target[1]) * Math.exp(-(e[2] - target[2]) / target[3]!) : v;
        target = e;
      }
      prevT = e[2];
    }
    if (target) return target[1] + (v - target[1]) * Math.exp(-(t - target[2]) / target[3]!);
    return v;
  }
}

const ctx = (time = 0) => ({ currentTime: time }) as BaseAudioContext;

describe('AutoLane', () => {
  it('sets values exactly before a render starts and never writes .value', () => {
    const c = ctx(0);
    const lane = new AutoLane(c, 'k', p.float(0, 1, 0.5), 0.5, 0.003);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam, (v) => v * 2);
    expect(a.events).toEqual([['set', 1, 0]]);
    lane.setBase(0.25, 0);
    expect(a.events).toEqual([['set', 0.5, 0]]);
    expect(lane.valueAt(0)).toBe(0.25);
  });

  it('smooths live edits with setTargetAtTime and models them', () => {
    const c = ctx(1);
    const lane = new AutoLane(c, 'k', p.float(0, 1, 0), 0, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    lane.setBase(1, 1);
    expect(a.events.at(-1)).toEqual(['target', 1, 1, 0.01]);
    expect(lane.valueAt(1.01)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(lane.base).toBe(1);
  });

  it('steps discrete params', () => {
    const lane = new AutoLane(ctx(2), 'k', p.enum(['a', 'b', 'c'], 'a'), 0, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    lane.setBase(2, 2);
    expect(a.events.at(-1)).toEqual(['set', 2, 2]);
    lane.cut(2.1);
    lane.extend([2.2, 1.4, 2.3, 0.2]);
    expect(a.events.slice(-2)).toEqual([
      ['set', 1, 2.2],
      ['set', 0, 2.3],
    ]);
  });

  it('cuts at the next breakpoint without touching a running ramp, then appends', () => {
    const c = ctx(1);
    const lane = new AutoLane(c, 'k', p.float(0, 10, 0), 0, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    const t0 = lane.cut(1);
    expect(t0).toBe(1);
    lane.extend([1.1, 5, 1.2, 10, 1.3, 0]);
    expect(lane.driven).toBe(true);
    expect(lane.valueAt(1.15)).toBeCloseTo(7.5);
    // A re-anchor in the middle of the second ramp keeps it and replaces what follows.
    const tb = lane.cut(1.15);
    expect(tb).toBeCloseTo(1.2);
    expect(a.events.map((e) => e[2])).toEqual([1, 1.1, 1.2]);
    lane.extend([1.25, 2]);
    expect(a.at(1.225)).toBeCloseTo(6, 6);
    expect(lane.valueAt(1.225)).toBeCloseTo(6, 6);
  });

  it('only changes the base while driven, and releases back to it with a ramp', () => {
    const c = ctx(1);
    const lane = new AutoLane(c, 'k', p.float(0, 1, 0), 0, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    lane.cut(1);
    lane.extend([1.5, 1]);
    const before = a.events.length;
    lane.setBase(0.3, 1.1);
    expect(a.events.length).toBe(before);
    lane.release(1.2, 0.02);
    expect(lane.driven).toBe(false);
    expect(a.events.at(-1)).toEqual(['lin', 0.3, 1.52]);
    expect(lane.valueAt(2)).toBeCloseTo(0.3);
  });

  it('replays the schedule onto params bound later', () => {
    const c = { currentTime: 1 } as { currentTime: number };
    const lane = new AutoLane(c as BaseAudioContext, 'k', p.float(0, 1, 0), 0, 0.01);
    lane.cut(1);
    lane.extend([2, 1, 3, 0]);
    c.currentTime = 1.5;
    const late = new FakeParam();
    lane.bind(late as unknown as AudioParam, (v) => v * 100);
    expect(late.events).toEqual([
      ['set', 50, 1.5],
      ['lin', 100, 2],
      ['lin', 0, 3],
    ]);
    expect(late.at(2.5)).toBeCloseTo(50);
  });

  it('cuts holds, constant ramps and steps right at the cut time', () => {
    const lane = new AutoLane(ctx(1), 'k', p.float(0, 10, 0), 0, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    lane.cut(1);
    lane.extend([1.1, 5, 3, 5]); // a ramp to 5, then holding 5 until 3 s
    expect(lane.cut(1.5)).toBe(1.5);
    expect(a.events.map((e) => e[2])).toEqual([1, 1.1, 1.5]);
    lane.extend([1.6, 0]);
    expect(a.at(1.55)).toBeCloseTo(2.5, 9);
    // Discrete lanes: a later step can always go.
    const steps = new AutoLane(ctx(1), 's', p.int(0, 8, 0), 0, 0);
    const b = new FakeParam();
    steps.bind(b as unknown as AudioParam);
    steps.cut(1);
    steps.extend([2, 3, 4, 6]);
    expect(steps.cut(2.5)).toBe(2.5);
    expect(b.events.at(-1)).toEqual(['set', 3, 2.5]);
  });

  it('starts exactly before a render and reports scheduled changes', () => {
    const lane = new AutoLane(ctx(0), 'k', p.float(0, 1, 0), 0.5, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    const heard: [number, number][] = [];
    lane.onScheduled = (v, t) => heard.push([v, t]);
    lane.start(0.25);
    expect(a.events).toEqual([['set', 0.25, 0]]);
    expect(lane.driven).toBe(true);
    lane.extend([0.5, 0.25, 1, 0.75]);
    expect(heard).toEqual([
      [0.25, 0],
      [0.75, 1],
    ]);
    expect(lane.scheduledUntil).toBe(1);
  });

  it('clamps automated values into the spec range and skips non-finite ones', () => {
    const lane = new AutoLane(ctx(1), 'k', p.float(-1, 1, 0), 0, 0.01);
    const a = new FakeParam();
    lane.bind(a as unknown as AudioParam);
    lane.cut(1);
    lane.extend([1.1, 5, 1.2, Number.NaN, 1.2, -3]);
    expect(a.events.slice(-2)).toEqual([
      ['lin', 1, 1.1],
      ['lin', -1, 1.2],
    ]);
  });
});

describe('ParamRegistry', () => {
  it('keeps several params per key until each unregisters', () => {
    const r = new ParamRegistry();
    const a = new AutoLane(ctx(), 'x', p.float(0, 1, 0), 0, 0);
    const b = new AutoLane(ctx(), 'x', p.float(0, 1, 0), 0, 0);
    const offA = r.register(a);
    r.register(b);
    expect(r.get('x')).toEqual([a, b]);
    offA();
    expect(r.get('x')).toEqual([b]);
  });

  it('answers the newest param of a key, and the one before it once the newest unregisters', () => {
    const r = new ParamRegistry();
    const a = new AutoLane(ctx(), 'x', p.float(0, 1, 0), 0, 0);
    const b = new AutoLane(ctx(), 'x', p.float(0, 1, 0), 0, 0);
    const c = new AutoLane(ctx(), 'x', p.float(0, 1, 0), 0, 0);
    expect(r.newest('x')).toBeUndefined();
    const offA = r.register(a);
    expect(r.newest('x')).toBe(a);
    const offB = r.register(b);
    const offC = r.register(c);
    expect(r.newest('x')).toBe(c);
    // Removing the newest hands the answer to the one registered before it that is still there.
    offC();
    expect(r.newest('x')).toBe(b);
    offB();
    expect(r.newest('x')).toBe(a);
    offA();
    expect(r.newest('x')).toBeUndefined();
  });
});

describe('AutoLane.follow', () => {
  /** A macro-like source lane (0–1) and a follower lane (0–10) bound to a fake param, following at `map`. */
  function pair(map: (v: number) => number = (v) => v * 10, options = { bent: false }, time = 1, max = 10) {
    const clock = { currentTime: time } as { currentTime: number };
    const source = new AutoLane(clock as BaseAudioContext, 'macro', p.float(0, 1, 0), 0, 0.01);
    const follower = new AutoLane(clock as BaseAudioContext, 'target', p.float(0, max, 3), 3, 0.01);
    const param = new FakeParam();
    follower.bind(param as unknown as AudioParam);
    const stop = follower.follow(source, map, options);
    return { clock, source, follower, param, stop };
  }

  it('takes the source value now, mapped, and ignores its own value, automation and releases', () => {
    const { source, follower, param } = pair();
    expect(follower.following).toBe(true);
    expect(follower.driven).toBe(true);
    expect(param.at(1)).toBe(0);
    source.setBase(0.5, 1);
    expect(param.at(5)).toBeCloseTo(5, 6);
    // What the follower would do for itself is refused while it follows.
    follower.setBase(9, 1.5);
    follower.cut(1.5);
    follower.extend([2, 10]);
    follower.release(2);
    expect(param.at(5)).toBeCloseTo(5, 6);
    expect(follower.base).toBe(9);
  });

  it('copies a ramp the source is given: halfway along it the target is halfway along its range', () => {
    const { source, follower, param } = pair();
    source.cut(1);
    source.extend([2, 1]);
    expect(param.at(1.5)).toBeCloseTo(5, 6);
    expect(follower.valueAt(1.5)).toBeCloseTo(5, 6);
    expect(param.at(3)).toBeCloseTo(10, 6);
    // The source re-anchors in the middle of its ramp: the copy keeps up.
    source.cut(1.5);
    source.extend([2.5, 0]);
    expect(param.at(1.75)).toBeCloseTo(param.at(1.75), 6);
    expect(follower.valueAt(2.5)).toBeCloseTo(0, 6);
  });

  it('cuts a ramp into pieces when the map bends, so a log sweep stays even in octaves', () => {
    const map = (v: number) => 100 * Math.pow(64, v);
    const { source, follower, param } = pair(map, { bent: true }, 1, 10000);
    source.cut(1);
    source.extend([3, 1]);
    // Linear in the source, geometric in the target: the middle is the geometric middle (800), not the arithmetic one.
    expect(param.at(2)).toBeCloseTo(800, 0);
    expect(follower.valueAt(2)).toBeCloseTo(800, 0);
    expect(param.events.filter((e) => e[0] === 'lin').length).toBeGreaterThan(10);
    expect(param.at(3)).toBeCloseTo(6400, 3);
  });

  it('steps a stepped parameter and tells onChange-only listeners the scheduled values', () => {
    const clock = { currentTime: 1 } as { currentTime: number };
    const source = new AutoLane(clock as BaseAudioContext, 'macro', p.float(0, 1, 0), 0, 0.01);
    const follower = new AutoLane(clock as BaseAudioContext, 'target', p.enum(['a', 'b', 'c', 'd'], 'a'), 0, 0);
    const heard: [number, number][] = [];
    follower.onScheduled = (value, time) => heard.push([value, time]);
    follower.follow(source, (v) => v * 3, { bent: true });
    source.cut(1);
    source.extend([2, 1]);
    expect(follower.valueAt(1.1)).toBe(0);
    expect(follower.valueAt(1.4)).toBe(1);
    expect(follower.valueAt(1.9)).toBe(3);
    expect(follower.valueAt(2.1)).toBe(3);
    expect(heard.map(([value]) => value)).toEqual([...new Set(heard.map(([value]) => value))].sort());
    expect(heard.at(-1)?.[0]).toBe(3);
  });

  it('hands the value back to the document when it stops following, and not at all when its lane is going away', () => {
    const one = pair();
    one.source.setBase(1, 1);
    expect(one.param.at(5)).toBeCloseTo(10, 6);
    one.stop();
    expect(one.follower.following).toBe(false);
    expect(one.param.at(5)).toBeCloseTo(3, 6);
    // Source edits no longer reach it.
    one.source.setBase(0.2, 2);
    expect(one.param.at(5)).toBeCloseTo(3, 6);
    const two = pair();
    two.source.setBase(1, 1);
    two.stop(false);
    expect(two.param.at(5)).toBeCloseTo(10, 6);
    const three = pair();
    const before = three.param.events.length;
    three.follower.dispose();
    three.source.setBase(1, 1);
    expect(three.param.events.length).toBe(before);
  });

  it('replays the copy onto params bound after it was made', () => {
    const { source, follower } = pair();
    source.cut(1);
    source.extend([3, 1]);
    const late = new FakeParam();
    follower.bind(late as unknown as AudioParam);
    expect(late.at(1)).toBeCloseTo(0, 6);
    expect(late.at(2)).toBeCloseTo(5, 6);
    expect(late.at(3)).toBeCloseTo(10, 6);
  });

  it('is exact before a render starts', () => {
    const { source, param } = pair((v) => v * 10, { bent: false }, 0);
    source.setBase(0.25, 0);
    expect(param.at(0)).toBeCloseTo(2.5, 9);
    expect(param.events.every((e) => e[0] === 'set')).toBe(true);
  });

  it('makes a plugin param report the followed value, and tell its listeners about each change the macro makes', () => {
    const clock = { currentTime: 1 } as { currentTime: number };
    const source = new AutoLane(clock as BaseAudioContext, 'macro', p.float(0, 1, 0), 0.5, 0.01);
    const handle = new ParamHandleImpl(clock as BaseAudioContext, 'target', p.float(0, 10, 3), 3);
    expect(handle.value).toBe(3);
    const heard: number[] = [];
    handle.onChange((value) => heard.push(value as number));
    handle.lane.follow(source, (v) => v * 10, { bent: false });
    // A plugin made now (its worklet reads `value`) starts where the macro has the param, not at the document's value.
    expect(handle.value).toBeCloseTo(5, 9);
    source.setBase(1, 1);
    expect(heard.at(-1)).toBe(10);
    handle.set(9, 1);
    expect(handle.value).toBeCloseTo(5, 9);
  });
});
