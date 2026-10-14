import { beforeEach, describe, expect, it } from 'vitest';
import { produce, produceWithPatches, enablePatches } from 'immer';
import { p as params } from '@agstudio/sdk/params';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { MASTER, type AutoPoint, type ChannelId, type InsertId, type Project } from '../model/types';
import { addChannel, setChannelProp, setPluginParam } from '../ops/channels';
import { addFxSlot, setFxSlotMix, setInsertProp } from '../ops/mixer';
import {
  addAutomationPoint,
  createAutomationClip,
  firstFreeLane,
  moveAutomationPoint,
  removeAutomation,
  removeAutomationPoint,
  setAutomationPointShape,
  setAutomationPointTension,
  setAutomationPoints,
} from '../ops/automation';
import { targetsChangedBy } from './changes';
import { curveAt } from './curve';
import { lfoPoints, mergePasses, spliceCurve, thinSamples } from './generate';
import { automationLabel, formatAutomationValue, targetName } from './labels';
import { automationAt, automationModelOf } from './model';
import { resolveTarget } from './targets';

enablePatches();
beforeEach(() => setIdSource(seededBytes(3)));

const SYNTH = { name: '3xOsc', params: { cutoff: params.float(20, 20000, 1000, { label: 'Cutoff', scale: 'log', unit: 'Hz' }) } };
const plugins = (id: string) => (id === 'x.synth' ? SYNTH : id === 'x.fx' ? { name: 'Filter', params: SYNTH.params } : undefined);

function project(): { p: Project; ch: ChannelId; ins: InsertId } {
  const ch = makeInstrumentChannel('3xOsc', makePluginInstance('x.synth', 1, { cutoff: 1000 }));
  const p = produce(createEmptyProject({ now: new Date(0) }), (d) => {
    addChannel(d, ch);
  });
  return { p, ch: ch.id, ins: p.mixer.order[3] as InsertId };
}

const pt = (tick: number, value: number, extra: Partial<AutoPoint> = {}): AutoPoint => ({ tick, value, ...extra });

describe('automation ops', () => {
  it('creates a channel and a clip on the first free lane, two points at the value', () => {
    const { p, ch } = project();
    const target = { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'cutoff' } as const;
    let ids!: ReturnType<typeof createAutomationClip>;
    const next = produce(p, (d) => {
      ids = createAutomationClip(d, { target, name: 'Cutoff · 3xOsc', color: '#fff', start: 3840, length: 7680, value: 0.4 });
    });
    const auto = next.channels[ids.channelId];
    expect(auto?.kind === 'automation' && auto.points).toEqual([pt(0, 0.4), pt(7680, 0.4)]);
    expect(next.channelOrder).toContain(ids.channelId);
    expect(next.playlist.clips[ids.clipId]).toMatchObject({ kind: 'automation', start: 3840, length: 7680, offset: 0 });
    expect(ids.laneId).toBe(p.playlist.laneOrder[0]);
    // The model plays it.
    const ta = automationModelOf(next).targets.get(`plug:ch:${ch}:cutoff`)!;
    expect(automationAt(ta, 5000)!.value).toBeCloseTo(0.4);
    // The next one goes to the next free lane; when every lane is busy, a new lane is added.
    const busy = produce(next, (d) => {
      for (const lane of d.playlist.laneOrder.slice(1))
        createAutomationClip(d, { target, name: 'x', color: '#fff', start: 0, length: 3840 * 4, laneId: lane });
    });
    expect(firstFreeLane(busy, 3840, 7680)).toBeNull();
    const more = produce(busy, (d) => {
      const r = createAutomationClip(d, { target, name: 'x', color: '#fff', start: 3840, length: 3840 });
      expect(d.playlist.laneOrder.at(-1)).toBe(r.laneId);
    });
    expect(more.playlist.laneOrder.length).toBe(busy.playlist.laneOrder.length + 1);
  });

  it('edits points: add in order, move between neighbours, delete, shape and tension', () => {
    const { p, ch } = project();
    let id!: ChannelId;
    const base = produce(p, (d) => {
      id = createAutomationClip(d, {
        target: { kind: 'channel', channelId: ch, param: 'volume' },
        name: 'v',
        color: '#fff',
        start: 0,
        length: 3840,
      }).channelId;
    });
    const points = (pr: Project) => {
      const c = pr.channels[id];
      return c?.kind === 'automation' ? c.points : [];
    };
    let index = -1;
    const added = produce(base, (d) => {
      index = addAutomationPoint(d, id, pt(1000.4, 1.5));
    });
    expect(index).toBe(1);
    expect(points(added)[1]).toEqual(pt(1000, 1));
    const moved = produce(added, (d) => moveAutomationPoint(d, id, 1, 99999, -2));
    expect(points(moved)[1]).toEqual(pt(3840, 0));
    const shaped = produce(moved, (d) => {
      setAutomationPointShape(d, id, 0, 'stairs');
      setAutomationPointTension(d, id, 0, 3);
    });
    expect(points(shaped)[0]).toEqual({ tick: 0, value: 0.5, shape: 'stairs', tension: 1 });
    const straight = produce(shaped, (d) => {
      setAutomationPointShape(d, id, 0, 'curve');
      setAutomationPointTension(d, id, 0, 0);
    });
    expect(points(straight)[0]).toEqual(pt(0, 0.5));
    const fewer = produce(straight, (d) => {
      removeAutomationPoint(d, id, 1);
      removeAutomationPoint(d, id, 0);
      removeAutomationPoint(d, id, 0); // the last point stays
    });
    expect(points(fewer)).toHaveLength(1);
    const replaced = produce(fewer, (d) => setAutomationPoints(d, id, [pt(50, 0.2), pt(10, 0.9)]));
    expect(points(replaced)).toEqual([pt(10, 0.9), pt(50, 0.2)]);
    const gone = produce(replaced, (d) => removeAutomation(d, id));
    expect(gone.channels[id]).toBeUndefined();
    expect(Object.values(gone.playlist.clips).some((c) => c.kind === 'automation')).toBe(false);
  });
});

describe('labels', () => {
  it('names targets in plain words and formats values with units', () => {
    const { p, ch, ins } = project();
    const q = produce(p, (d) => {
      addFxSlot(d, ins, makePluginInstance('x.fx', 1, { cutoff: 500 }));
    });
    const slot = q.mixer.inserts[ins]!.fx[0]!.id;
    expect(targetName(q, { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'cutoff' }, plugins)).toBe(
      'Cutoff · 3xOsc',
    );
    expect(targetName(q, { kind: 'insert', insertId: ins, param: 'volume' }, plugins)).toBe('Volume · Insert 3');
    expect(targetName(q, { kind: 'plugin', owner: { kind: 'fx', insertId: ins, slotId: slot }, paramId: 'cutoff' }, plugins)).toBe(
      'Cutoff · Filter (Insert 3)',
    );
    expect(targetName(q, { kind: 'slot', insertId: ins, slotId: slot, param: 'mix' }, plugins)).toBe('Mix · Filter (Insert 3)');
    expect(targetName(q, { kind: 'route', insertId: ins, to: MASTER }, plugins)).toBe('Send · Insert 3 → Master');
    expect(targetName(q, { kind: 'channel', channelId: ch, param: 'pan' }, plugins)).toBe('Pan · 3xOsc');
    expect(targetName(q, { kind: 'tempo' }, plugins)).toBe('Tempo');
    expect(targetName(q, { kind: 'channel', channelId: 'ch_gone' as ChannelId, param: 'pan' }, plugins)).toBeNull();
    const auto = {
      kind: 'automation' as const,
      id: 'ch_a' as ChannelId,
      name: 'Old name',
      color: '#fff',
      muted: false,
      solo: false,
      target: { kind: 'channel' as const, channelId: 'ch_gone' as ChannelId, param: 'pan' as const },
      points: [],
    };
    expect(automationLabel(q, auto, plugins)).toBe('Old name (target deleted)');
    const specs = (id: string) => plugins(id)?.params;
    const vol = resolveTarget(q, { kind: 'insert', insertId: ins, param: 'volume' }, specs)!;
    expect(formatAutomationValue(vol, { kind: 'insert', insertId: ins, param: 'volume' }, 0.8)).toBe('0.0 dB');
    const pan = resolveTarget(q, { kind: 'channel', channelId: ch, param: 'pan' }, specs)!;
    expect(formatAutomationValue(pan, { kind: 'channel', channelId: ch, param: 'pan' }, 0.25)).toBe('50% L');
    expect(formatAutomationValue(pan, { kind: 'channel', channelId: ch, param: 'pan' }, 0.5)).toBe('Center');
    const cutoff = { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'cutoff' } as const;
    expect(formatAutomationValue(resolveTarget(q, cutoff, specs)!, cutoff, 0.5)).toBe('632 Hz');
    const tempo = resolveTarget(q, { kind: 'tempo' }, specs, { min: 60, max: 180 })!;
    expect(formatAutomationValue(tempo, { kind: 'tempo' }, 0.5)).toBe('120 BPM');
  });
});

describe('targetsChangedBy', () => {
  it('reads moved controls from patches', () => {
    const { p, ch, ins } = project();
    const withFx = produce(p, (d) => {
      addFxSlot(d, ins, makePluginInstance('x.fx', 1, { cutoff: 500 }));
    });
    const slot = withFx.mixer.inserts[ins]!.fx[0]!.id;
    const [next, patches] = produceWithPatches(withFx, (d) => {
      setChannelProp(d, ch, 'volume', 0.5);
      setPluginParam(d, { kind: 'channel', channelId: ch }, 'cutoff', 2000);
      setInsertProp(d, ins, 'pan', 0.3);
      setFxSlotMix(d, ins, slot, 0.4);
      setPluginParam(d, { kind: 'fx', insertId: ins, slotId: slot }, 'cutoff', 900);
      d.mixer.inserts[ins]!.routes[0]!.level = 0.5;
      d.transport.bpm = 140;
      d.channels[ch]!.name = 'Renamed';
    });
    const keys = targetsChangedBy(withFx, next, patches)
      .map((t) => JSON.stringify(t))
      .sort();
    expect(keys).toEqual(
      [
        { kind: 'channel', channelId: ch, param: 'volume' },
        { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'cutoff' },
        { kind: 'insert', insertId: ins, param: 'pan' },
        { kind: 'slot', insertId: ins, slotId: slot, param: 'mix' },
        { kind: 'plugin', owner: { kind: 'fx', insertId: ins, slotId: slot }, paramId: 'cutoff' },
        { kind: 'route', insertId: ins, to: MASTER },
        { kind: 'tempo' },
      ]
        .map((t) => JSON.stringify(t))
        .sort(),
    );
    // A whole replaced instance compares its params.
    const [swapped, patches2] = produceWithPatches(next, (d) => {
      const c = d.channels[ch];
      if (c?.kind === 'instrument') c.plugin = makePluginInstance('x.synth', 1, { cutoff: 50 });
    });
    expect(targetsChangedBy(next, swapped, patches2)).toEqual([
      { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'cutoff' },
    ]);
  });
});

describe('generated curves', () => {
  const opts = { period: 960, depth: 0.8, center: 0.5, phase: 0 };
  it('makes LFO shapes that follow their waves', () => {
    // A cycle starts low and peaks halfway: whole cycles need only their peaks.
    const sine = lfoPoints(0, 3840, { ...opts, shape: 'sine' });
    expect(sine).toHaveLength(9);
    for (let t = 0; t <= 3840; t += 37) {
      const want = 0.5 - 0.4 * Math.cos((2 * Math.PI * t) / 960);
      expect(curveAt(sine, t)!).toBeCloseTo(want, 6);
    }
    expect(curveAt(sine, 480)).toBeCloseTo(0.9, 6);
    expect(curveAt(sine, 960)).toBeCloseTo(0.1, 6);
    // A phase that isn't a whole half cycle samples the part before the first peak.
    const shifted = lfoPoints(0, 1920, { ...opts, shape: 'sine', phase: 0.1 });
    for (let t = 0; t <= 1920; t += 23) {
      const want = 0.5 - 0.4 * Math.cos(2 * Math.PI * (t / 960 + 0.1));
      expect(curveAt(shifted, t)!).toBeCloseTo(want, 2);
    }
    const tri = lfoPoints(0, 1920, { ...opts, shape: 'triangle' });
    expect(curveAt(tri, 120)).toBeCloseTo(0.3, 6);
    const saw = lfoPoints(0, 1920, { ...opts, shape: 'saw' });
    expect(curveAt(saw, 480)).toBeCloseTo(0.5, 6);
    expect(curveAt(saw, 959)).toBeCloseTo(0.9, 2);
    expect(curveAt(saw, 960)).toBeCloseTo(0.1, 6);
    const square = lfoPoints(0, 1920, { ...opts, shape: 'square', phase: 0.5 });
    expect(curveAt(square, 100)).toBeCloseTo(0.1, 6);
    expect(curveAt(square, 600)).toBeCloseTo(0.9, 6);
    const a = lfoPoints(0, 3840, { ...opts, shape: 'random', seed: 5 });
    expect(lfoPoints(0, 3840, { ...opts, shape: 'random', seed: 5 })).toEqual(a);
    for (const pt2 of a) expect(pt2.value).toBeGreaterThanOrEqual(0.1 - 1e-9);
    for (const curve of [sine, tri, saw, square, a]) {
      for (let i = 1; i < curve.length; i++) expect(curve[i]!.tick).toBeGreaterThanOrEqual(curve[i - 1]!.tick);
      expect(curve[0]!.tick).toBe(0);
      expect(curve.at(-1)!.tick).toBe(curve === tri || curve === saw || curve === square ? 1920 : 3840);
    }
  });

  it('thins recorded samples to the points that matter', () => {
    const line = Array.from({ length: 100 }, (_, i) => ({ tick: i * 10, value: i / 100 }));
    expect(thinSamples(line)).toHaveLength(2);
    const step = [...line.slice(0, 50).map((s) => ({ ...s, value: 0.2 })), ...line.slice(50).map((s) => ({ ...s, value: 0.8 }))];
    const thin = thinSamples(step);
    expect(thin.length).toBeLessThanOrEqual(4);
    for (const s of step) expect(Math.abs(curveAt(thin, s.tick)! - s.value)).toBeLessThan(0.31);
    const wavy = Array.from({ length: 400 }, (_, i) => ({ tick: i * 5, value: 0.5 + 0.4 * Math.sin(i / 20) }));
    const kept = thinSamples(wavy, 0.005);
    expect(kept.length).toBeLessThan(80);
    for (const s of wavy) expect(Math.abs(curveAt(kept, s.tick)! - s.value)).toBeLessThanOrEqual(0.0051);
  });

  it('merges loop passes (later wins) and splices a take into a curve', () => {
    const merged = mergePasses([
      [
        { tick: 0, value: 0.1 },
        { tick: 500, value: 0.1 },
        { tick: 1000, value: 0.1 },
      ],
      [
        { tick: 400, value: 0.9 },
        { tick: 600, value: 0.9 },
      ],
    ]);
    expect(merged.map((s) => [s.tick, s.value])).toEqual([
      [0, 0.1],
      [400, 0.9],
      [600, 0.9],
      [1000, 0.1],
    ]);
    const curve = [pt(0, 0), pt(1000, 1)];
    const out = spliceCurve(curve, [pt(400, 0.9), pt(600, 0.2)]);
    expect(out).toEqual([pt(0, 0), pt(400, 0.4), pt(400, 0.9), pt(600, 0.2), pt(600, 0.6), pt(1000, 1)]);
  });
});
