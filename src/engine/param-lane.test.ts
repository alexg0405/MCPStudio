import { describe, expect, it } from 'vitest';
import { p } from '@agstudio/sdk';
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
});
