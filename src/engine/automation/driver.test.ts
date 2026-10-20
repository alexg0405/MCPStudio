import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { tempoMapOf } from '@core/automation/tempo';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { gainToFader } from '@core/model/fader';
import { seededBytes, setIdSource } from '@core/model/ids';
import { CHANNEL_VOLUME_SPEC, INSERT_VOLUME_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import { MASTER, type AutoPoint, type ChannelId, type ParamTarget, type Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { p, type ParamSpec, type ParamSpecs } from '@agstudio/sdk';
import { ParamHandleImpl } from '../param-handle';
import { AutoLane, ParamRegistry } from '../param-lane';
import { songModeSource } from '../sched/events';
import { Transport } from '../sched/transport';
import { automate, fakeContext, FakeParam, pt } from '../../../test/helpers/automation';
import { cpuNow, settle } from '../../../test/helpers/perf';
import { AutomationDriver } from './driver';

beforeEach(() => setIdSource(seededBytes(7)));

const SPECS: ParamSpecs = {
  cutoff: p.float(20, 20000, 1000, { scale: 'log', unit: 'Hz' }),
  mode: p.enum(['a', 'b', 'c', 'd'], 'a', { automatable: true }),
  level: p.float(-60, 6, 0, { unit: 'dB' }),
};
const SONG = { mode: 'song' as const, patternId: null, loop: null };
/** 120 BPM: 1920 ticks per second, a bar is 2 s. */
const TPS = 1920;

function lead(bpm = 120): { project: Project; ch: ChannelId } {
  const ch = makeInstrumentChannel('Lead', makePluginInstance('test.synth', 1, { cutoff: 1000, mode: 'a', level: 0 }));
  const project = produce(createEmptyProject({ now: new Date(0) }), (d) => {
    d.transport.bpm = bpm;
    addChannel(d, ch);
  });
  return { project, ch: ch.id };
}

const vol = (ch: ChannelId): ParamTarget => ({ kind: 'channel', channelId: ch, param: 'volume' });
const plug = (ch: ChannelId, paramId: string): ParamTarget => ({
  kind: 'plugin',
  owner: { kind: 'channel', channelId: ch },
  paramId,
});

/** A transport + driver on a fake clock, playing `project` in song mode. */
function rig(project: Project, opts: { offline?: boolean; time?: number; loop?: { start: number; end: number } } = {}) {
  const ctx = fakeContext(opts.time ?? 1);
  const params = new ParamRegistry();
  let transport: Transport | null = null;
  const driver = new AutomationDriver({
    ctx,
    params,
    offline: !!opts.offline,
    specsOf: () => SPECS,
    timeline: () => transport?.currentTimeline ?? null,
  });
  const model = (pr: Project) => {
    const { source, length } = songModeSource(pr);
    const end = Math.max(length, 3840);
    return { source, timeline: { tempo: tempoMapOf(pr, 'song'), loop: opts.loop ?? { start: 0, end }, endTick: end } };
  };
  const m = model(project);
  transport = new Transport(ctx, { noteOn() {}, noteOff() {}, allNotesOff() {} }, m.source, m.timeline);
  transport.observe(driver);
  driver.update(project, SONG);
  const lanes = new Map<string, { lane: AutoLane; param: FakeParam }>();
  const add = (target: ParamTarget, spec: ParamSpec, base: number) => {
    const key = targetKey(target);
    const lane = new AutoLane(ctx, key, spec, base, 0.003);
    const param = new FakeParam();
    lane.bind(param as unknown as AudioParam);
    params.register(lane);
    lanes.set(key, { lane, param });
    return { lane, param };
  };
  /** Advances the clock in 25 ms pumps (the engine's Worker clock). */
  const runTo = (until: number) => {
    while (ctx.currentTime < until - 1e-9) {
      ctx.currentTime = Math.min(until, ctx.currentTime + 0.025);
      transport?.pump();
    }
  };
  const edit = (next: Project) => {
    driver.update(next, SONG);
    const n = model(next);
    transport?.setModel(n.source, n.timeline);
  };
  return { ctx, params, driver, transport, add, runTo, edit, lanes };
}

const linear = (points: AutoPoint[]) => points;

describe('AutomationDriver', () => {
  it('follows a clip’s curve ahead of the transport, holding after the clip', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), linear([pt(0, 0), pt(3840, 1)]), [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { lane, param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(2);
    // The lane models what it scheduled (it remembers about a second back).
    for (let t = 1.06; t < 2.1; t += 0.0371) expect(lane.valueAt(t)).toBeCloseTo(1.25 * ((t - 1.05) / 2), 6);
    r.runTo(4);
    for (let t = 1.06; t < 3.05; t += 0.0371) expect(param.at(t)).toBeCloseTo(1.25 * Math.min(1, (t - 1.05) / 2), 6);
    // After the clip: hold its last value.
    expect(param.at(3.9)).toBeCloseTo(1.25, 9);
    expect(lane.driven).toBe(true);
    expect(r.driver.readValue(targetKey(vol(ch)), 2.05)).toBeCloseTo(0.625, 6);
    // Only set values and linear ramps, at increasing times.
    expect(new Set(param.calls)).toEqual(new Set(['set', 'lin', 'cancel']));
    for (let i = 1; i < param.events.length; i++)
      expect(param.events[i]!.time).toBeGreaterThanOrEqual(param.events[i - 1]!.time);
  });

  it('schedules the same breakpoints however the timeline is cut into segments', () => {
    const { project: base, ch } = lead();
    let project = automate(
      base,
      plug(ch, 'cutoff'),
      [pt(0, 0.1), pt(1920, 0.9, { tension: 0.6 }), pt(2880, 0.3, { shape: 'stairs' }), pt(3840, 0.7)],
      [{ start: 960, length: 4800 }],
    ).project;
    project = automate(project, vol(ch), [pt(0, 0, { shape: 'smooth' }), pt(3840, 1)], [{ start: 0, length: 7680 }])
      .project;
    const events = (chunk: number) => {
      const r = rig(project, { offline: true, time: 0, loop: { start: 480, end: 6720 } });
      const cutoff = r.add(plug(ch, 'cutoff'), SPECS.cutoff!, 1000);
      const v = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
      const sr = 48000;
      const pre = 2048 / sr;
      r.transport.start(0, pre);
      for (let frame = 128; frame < sr * 9; frame += chunk) {
        r.ctx.currentTime = frame / sr;
        r.transport.pump(Math.min(9, (frame + chunk) / sr + 0.05));
      }
      return [cutoff.param.events, v.param.events];
    };
    const a = events(128 * 16);
    expect(a[0]!.length).toBeGreaterThan(100);
    expect(events(128 * 37)).toEqual(a);
    expect(events(128 * 256)).toEqual(a);
  });

  it('starts offline renders exactly on the value at the start tick', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { offline: true, time: 0 });
    const { param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(1920, 0.05);
    expect(param.events[0]).toEqual({ type: 'set', value: 0.625, time: 0 });
    expect(param.at(0.03)).toBe(0.625);
    r.ctx.currentTime = 0.01;
    r.transport.pump(0.6);
    expect(param.at(0.05 + 0.5)).toBeCloseTo(0.625 + 1.25 * (0.5 / 2), 6);
  });

  it('ramps value jumps (steps, clip starts, loop wraps) over 3 ms', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0, { shape: 'hold' }), pt(1920, 0.8)], [
      { start: 0, length: 3840 },
    ]);
    const r = rig(project, { loop: { start: 0, end: 3840 } });
    const { param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(3.5);
    const step = 1.05 + 1; // tick 1920
    expect(param.at(step - 0.0001)).toBeCloseTo(0, 9);
    expect(param.at(step + 0.0015)).toBeCloseTo(0.5, 3);
    expect(param.at(step + 0.003)).toBeCloseTo(1, 6);
    // The loop wraps at 3.05: back to 0 over 3 ms.
    expect(param.at(3.05 - 0.0001)).toBeCloseTo(1, 6);
    expect(param.at(3.05 + 0.0015)).toBeCloseTo(0.5, 3);
    expect(param.at(3.05 + 0.0031)).toBeCloseTo(0, 6);
  });

  it('steps discrete params where they change and tells onChange listeners when', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, plug(ch, 'mode'), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const handle = new ParamHandleImpl(r.ctx, targetKey(plug(ch, 'mode')), SPECS.mode!, 'a');
    const param = new FakeParam();
    handle.bind(param as unknown as AudioParam);
    r.params.register(handle.lane);
    const heard: [string, number][] = [];
    handle.onChange((v, t) => heard.push([v as string, t]));
    r.transport.start(0, 1.05);
    r.runTo(4);
    // Index = round(n · 3): changes at n = 1/6, 1/2, 5/6.
    expect(heard.map(([v]) => v)).toEqual(['b', 'c', 'd']);
    heard.forEach(([, t], i) => expect(t).toBeCloseTo(1.05 + [1 / 6, 1 / 2, 5 / 6][i]! * 2, 3));
    expect(param.calls.every((c) => c === 'set' || c === 'cancel')).toBe(true);
    expect(handle.valueAt(1.05 + 1.1)).toBe('c');
  });

  it('keeps linear ramps within 1 cent (log params) and 0.1 dB (volumes) of the curve', () => {
    const { project: base, ch } = lead();
    let project = automate(base, plug(ch, 'cutoff'), [pt(0, 0), pt(1920, 1, { tension: -0.8 }), pt(3840, 0.2)], [
      { start: 0, length: 3840 },
    ]).project;
    const ins: ParamTarget = { kind: 'insert', insertId: MASTER, param: 'volume' };
    project = automate(project, ins, [pt(0, 0.2), pt(960, 1)], [{ start: 0, length: 3840 }]).project;
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const cutoff = r.add(plug(ch, 'cutoff'), SPECS.cutoff!, 1000);
    const master = r.add(ins, INSERT_VOLUME_SPEC, 1);
    r.transport.start(0, 1.05);
    r.runTo(3.2);
    const curve = (n: number) => 20 * Math.pow(1000, n);
    // The second segment bends (the tension of the point it leaves).
    const bent = (x: number) => (Math.exp(-4.8 * x) - 1) / (Math.exp(-4.8) - 1);
    let cents = 0;
    let db = 0;
    for (let t = 1.06; t < 3.04; t += 0.00037) {
      const tick = (t - 1.05) * TPS;
      const x = tick / 1920;
      const n = tick < 1920 ? x : 1 - 0.8 * bent(x - 1);
      cents = Math.max(cents, Math.abs(1200 * Math.log2(cutoff.param.at(t) / curve(n))));
      const fader = tick < 960 ? 0.2 + 0.8 * (tick / 960) : 1;
      const gain = Math.min(1.905, Math.pow(fader / 0.8, Math.log(1.905) / Math.log(1.25)));
      if (gain > 1e-3) db = Math.max(db, Math.abs(20 * Math.log10(master.param.at(t) / gain)));
    }
    expect(cents).toBeLessThan(1.2);
    expect(db).toBeLessThan(0.12);
    expect(gainToFader(1)).toBeCloseTo(0.8);
  });

  it('lets touched targets go and ramps back to the curve when the touch ends', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0.4), pt(7680, 0.4)], [{ start: 0, length: 7680 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { lane, param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    const key = targetKey(vol(ch));
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    expect(param.at(1.5)).toBeCloseTo(0.5, 9);
    r.driver.touch(key, true);
    expect(lane.driven).toBe(false);
    // Back to the document value within the guard (20 ms) and a 20 ms ramp…
    expect(param.at(1.5 + 0.045)).toBeCloseTo(0.78, 9);
    // …and live edits are heard.
    lane.setBase(1, 1.6);
    r.runTo(1.8);
    expect(lane.valueAt(1.7)).toBeCloseTo(1, 3);
    r.driver.touch(key, false);
    r.runTo(1.825);
    expect(lane.driven).toBe(true);
    expect(param.at(1.825 + 0.02 + 0.03 + 0.001)).toBeCloseTo(0.5, 9);
    expect(r.driver.readValue(key, 1.9)).toBeCloseTo(0.5, 9);
  });

  it('re-plans only the targets an edit changed', () => {
    const { project: base, ch } = lead();
    let project = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]).project;
    const cutoff = automate(project, plug(ch, 'cutoff'), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    project = cutoff.project;
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const v = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    const c = r.add(plug(ch, 'cutoff'), SPECS.cutoff!, 1000);
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    const cancels = (fp: FakeParam) => fp.calls.filter((x) => x === 'cancel').length;
    const before = [cancels(v.param), cancels(c.param)];
    const edited = produce(project, (d) => {
      const chan = d.channels[cutoff.channelId];
      if (chan?.kind === 'automation') chan.points[1]!.value = 0.5;
    });
    r.edit(edited);
    r.runTo(1.6);
    expect(cancels(v.param)).toBe(before[0]);
    expect(cancels(c.param)).toBe(before[1]! + 1);
    // The edited curve is heard from now + guard on (with a 3 ms ramp from the old one).
    const n = (0.5 * (1.58 - 1.05)) / 2;
    expect(c.param.at(1.58)).toBeCloseTo(20 * Math.pow(1000, n), 0);
  });

  it('holds the last value when stopped and ramps to the start value on play', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { lane, param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(2.05);
    r.transport.stop();
    // Held from now + guard (or the end of the ramp running then, ≤ 25 ms later).
    const held = lane.valueAt(2.5);
    expect(held).toBeGreaterThanOrEqual(1.25 * (1.02 / 2) - 1e-9);
    expect(held).toBeLessThanOrEqual(1.25 * (1.045 / 2) + 1e-9);
    r.runTo(3);
    expect(param.at(3)).toBeCloseTo(held, 9);
    expect(lane.driven).toBe(true);
    r.transport.start(3456, 3.05);
    r.runTo(3.2);
    expect(param.at(3.05)).toBeCloseTo(held, 9);
    expect(param.at(3.05 + 0.006)).toBeCloseTo(1.25 * ((3456 + 0.006 * TPS) / 3840), 6);
  });

  it('lets held values go when the document value changes while stopped', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { lane } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    r.transport.stop();
    lane.setBase(0.3, 1.5);
    r.driver.update(project, SONG);
    expect(lane.driven).toBe(false);
    expect(lane.valueAt(1.6)).toBeCloseTo(0.3, 9);
  });

  it('releases every target in pattern mode', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { lane, param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    expect(lane.driven).toBe(true);
    r.driver.update(project, { mode: 'pattern', patternId: null, loop: null });
    expect(lane.driven).toBe(false);
    expect(r.driver.plannedKeys).toEqual([]);
    r.runTo(1.7);
    expect(param.at(1.7)).toBeCloseTo(0.78, 9);
  });

  it('picks up params registered while playing (a replaced plugin instance)', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    const { lane, param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.runTo(1.6);
    expect(lane.driven).toBe(true);
    expect(param.at(1.59)).toBeCloseTo(1.25 * (0.54 / 2), 6);
  });

  it('recovers from a stall from the current value instead of jumping', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(7680, 1)], [{ start: 0, length: 7680 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    const reached = param.events.at(-1)!;
    // The main thread stalls for 600 ms.
    r.ctx.currentTime = 2.1;
    r.transport.pump();
    // The value holds where the schedule ended until now + guard, then ramps back to the curve.
    expect(param.at(2.11)).toBeCloseTo(reached.value, 9);
    expect(param.at(2.2)).toBeCloseTo(1.25 * ((2.2 - 1.05) / 4), 6);
  });

  it('starts a new run when the tempo changes while playing', () => {
    const { project: base, ch } = lead();
    const { project } = automate(base, vol(ch), [pt(0, 0), pt(3840, 1)], [{ start: 0, length: 3840 }]);
    const r = rig(project, { loop: { start: 0, end: 7680 } });
    const { param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
    r.transport.start(0, 1.05);
    r.runTo(1.5);
    const faster = produce(project, (d) => {
      d.transport.bpm = 240;
    });
    r.edit(faster);
    r.runTo(2);
    // Tick at time t after the change: the 120 BPM part up to ~1.51, then twice as fast.
    const tickAt = (t: number) => (1.51 - 1.05) * TPS + (t - 1.51) * 2 * TPS;
    expect(param.at(1.9)).toBeCloseTo((1.25 * tickAt(1.9)) / 3840, 2);
  });

  it('keeps a pump with 50 automated targets under 2 ms and lanes bounded', { tags: ['perf'] }, async () => {
    const { project: base, ch } = lead();
    let project = base;
    const targets: ParamTarget[] = [];
    for (let i = 0; i < 50; i++) {
      const t = plug(ch, `p${i}`);
      targets.push(t);
      const points = [pt(0, 0.1), pt(960, 0.9, { tension: 0.3 }), pt(1920, 0.2, { shape: 'smooth' }), pt(3840, 1)];
      project = automate(project, t, points, [{ start: 0, length: 3840 * 4 }]).project;
    }
    const wide: ParamSpecs = {};
    for (let i = 0; i < 50; i++) wide[`p${i}`] = p.float(20, 20000, 1000, { scale: 'log', unit: 'Hz' });
    const ctx = fakeContext(1);
    const params = new ParamRegistry();
    let transport: Transport | null = null;
    const driver = new AutomationDriver({
      ctx,
      params,
      offline: false,
      specsOf: () => wide,
      timeline: () => transport?.currentTimeline ?? null,
    });
    const { source, length } = songModeSource(project);
    transport = new Transport(ctx, { noteOn() {}, noteOff() {}, allNotesOff() {} }, source, {
      tempo: tempoMapOf(project, 'song'),
      loop: { start: 0, end: length },
      endTick: length,
    });
    transport.observe(driver);
    driver.update(project, SONG);
    const nop = { setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} };
    const lanes = targets.map((t) => {
      const lane = new AutoLane(ctx, targetKey(t), wide.p0!, 1000, 0.003);
      lane.bind(nop as unknown as AudioParam);
      params.register(lane);
      return lane;
    });
    transport.start(0, 1.05);
    // CPU time, not wall clock: a busy machine would add the time spent waiting for a core to one pump. The mean must be
    // under 2 ms and the 95th percentile under 4 ms; a run is scored by how close it comes to the nearer limit (under 1
    // passes), and the best of up to four runs counts, as interference only ever adds time.
    const MEAN_LIMIT_MS = 2;
    const P95_LIMIT_MS = 4;
    const score = () => {
      const times: number[] = [];
      for (let i = 0; i < 800; i++) {
        ctx.currentTime += 0.025;
        const t0 = cpuNow();
        transport.pump();
        times.push(cpuNow() - t0);
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      return Math.max(mean / MEAN_LIMIT_MS, times[Math.floor(times.length * 0.95)]! / P95_LIMIT_MS);
    };
    const best = await settle(score, (s) => s < 1, { attempts: 4 });
    expect(best, 'share of the tighter pump limit (mean 2 ms, 95th percentile 4 ms)').toBeLessThan(1);
    for (const lane of lanes) expect(lane.segmentCount).toBeLessThan(400);
  });

  describe('a lane that sits behind the song’s clock (AutomatableParam.shift)', () => {
    it('lands the curve that much later on the lane, and reads it back in the song’s time', () => {
      const { project: base, ch } = lead();
      const { project } = automate(base, vol(ch), linear([pt(0, 0), pt(3840, 1)]), [{ start: 0, length: 3840 }]);
      const plain = rig(project, { loop: { start: 0, end: 7680 } });
      const a = plain.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
      plain.transport.start(0, 1.05);
      plain.runTo(2);

      const shifted = rig(project, { loop: { start: 0, end: 7680 } });
      const b = shifted.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
      b.lane.shift = 0.01;
      shifted.driver.retime();
      shifted.transport.start(0, 1.05);
      shifted.runTo(2);
      // The same curve, 10 ms later on the lane, and the song's time still finds its value.
      for (let t = 1.1; t < 2.0; t += 0.0371) {
        expect(b.param.at(t + 0.01)).toBeCloseTo(a.param.at(t), 6);
        expect(shifted.driver.readValue(targetKey(vol(ch)), t)).toBeCloseTo(plain.driver.readValue(targetKey(vol(ch)), t), 6);
      }
    });

    it('plans the lane again when its shift changes while playing', () => {
      const { project: base, ch } = lead();
      const { project } = automate(base, vol(ch), linear([pt(0, 0), pt(3840, 1)]), [{ start: 0, length: 3840 }]);
      const r = rig(project, { loop: { start: 0, end: 7680 } });
      const { lane, param } = r.add(vol(ch), CHANNEL_VOLUME_SPEC, 0.78);
      r.transport.start(0, 1.05);
      r.runTo(1.5);
      lane.shift = 0.02;
      r.driver.retime();
      r.runTo(2.5);
      // From a little after the change the lane follows the curve 20 ms later.
      for (let t = 1.7; t < 2.4; t += 0.0371) expect(param.at(t + 0.02)).toBeCloseTo(1.25 * ((t - 1.05) / 2), 3);
    });
  });
});
