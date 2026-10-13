import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import type { AutomationChannel, AutoPoint, ChannelId, ClipId, ParamTarget } from '../model/types';
import { p as params } from '@agstudio/sdk/params';
import { bend, curveAt, segmentValue } from './curve';
import { automationAt, automationModelOf } from './model';
import { resolveTarget } from './targets';
import { tempoMapOf } from './tempo';

beforeEach(() => setIdSource(seededBytes(11)));

const pt = (tick: number, value: number, extra: Partial<AutoPoint> = {}): AutoPoint => ({ tick, value, ...extra });

describe('curves', () => {
  it('evaluates shapes from the point that leaves the segment', () => {
    const a = pt(0, 0);
    const b = pt(100, 1);
    expect(segmentValue(a, b, 50)).toBeCloseTo(0.5);
    expect(segmentValue({ ...a, shape: 'hold' }, b, 99)).toBe(0);
    expect(segmentValue({ ...a, shape: 'smooth' }, b, 25)).toBeCloseTo(0.5 - 0.5 * Math.cos(Math.PI / 4));
    expect(segmentValue({ ...a, shape: 'stairs' }, b, 60)).toBe(0.5);
    expect(segmentValue({ ...a, tension: 0.5 }, b, 50)).toBeLessThan(0.5);
    expect(segmentValue({ ...a, tension: -0.5 }, b, 50)).toBeGreaterThan(0.5);
    expect(bend(0, 0.7)).toBe(0);
    expect(bend(1, -0.7)).toBeCloseTo(1);
  });

  it('holds the first and last values outside the points', () => {
    const pts = [pt(100, 0.2), pt(200, 0.8)];
    expect(curveAt(pts, 0)).toBe(0.2);
    expect(curveAt(pts, 150)).toBeCloseTo(0.5);
    expect(curveAt(pts, 999)).toBe(0.8);
    expect(curveAt([], 5)).toBeNull();
  });
});

function withAutomation(
  target: ParamTarget,
  points: AutoPoint[],
  clips: { start: number; length: number; offset?: number }[],
  extra: Partial<AutomationChannel> = {},
) {
  const proj = createEmptyProject({ now: new Date(0) });
  const lane = proj.playlist.laneOrder[0]!;
  const ch: AutomationChannel = {
    kind: 'automation',
    id: 'ch_auto' as ChannelId,
    name: 'Auto',
    color: '#fff',
    muted: false,
    solo: false,
    target,
    points,
    ...extra,
  };
  return produce(proj, (d) => {
    d.channels[ch.id] = ch;
    d.channelOrder.push(ch.id);
    clips.forEach((c, i) => {
      const id = `clip_a${i}` as ClipId;
      d.playlist.clips[id] = {
        kind: 'automation',
        id,
        laneId: lane,
        channelId: ch.id,
        start: c.start,
        length: c.length,
        offset: c.offset ?? 0,
      };
    });
  });
}

describe('automation model', () => {
  const target: ParamTarget = { kind: 'insert', insertId: 'master' as never, param: 'volume' };

  it('follows the rules: base before, curve inside, hold after, latest start wins', () => {
    const p = withAutomation(
      target,
      [pt(0, 0), pt(960, 1)],
      [
        { start: 960, length: 960 },
        { start: 1440, length: 960, offset: 0 },
      ],
    );
    const ta = automationModelOf(p).targets.get('ins:master:volume')!;
    expect(automationAt(ta, 0)).toBeNull();
    expect(automationAt(ta, 960 + 480)!.value).toBeCloseTo(0); // second clip started at 1440: its curve from 0
    expect(automationAt(ta, 1200)!.value).toBeCloseTo(0.25);
    expect(automationAt(ta, 1440 + 480)!.value).toBeCloseTo(0.5);
    expect(automationAt(ta, 5000)!.value).toBeCloseTo(1); // after the last clip: hold its end value
  });

  it('keeps unchanged targets identical across edits and ignores muted clips', () => {
    const p = withAutomation(target, [pt(0, 0), pt(960, 1)], [{ start: 0, length: 960 }]);
    const m1 = automationModelOf(p);
    const q = produce(p, (d) => {
      d.transport.swing = 0.3; // unrelated edit (same channels/playlist objects)
      const ch = makeInstrumentChannel('X', makePluginInstance('agstudio.3xosc', 1, {}));
      d.channels[ch.id] = ch;
    });
    const m2 = automationModelOf(q);
    expect(m2.targets.get('ins:master:volume')).toBe(m1.targets.get('ins:master:volume'));
    const muted = produce(q, (d) => {
      d.playlist.clips['clip_a0' as ClipId]!.muted = true;
    });
    expect(automationModelOf(muted).targets.size).toBe(0);
  });

  it('normalizes through each target: fader taper, plugin scales, tempo range', () => {
    const p = createEmptyProject({ now: new Date(0) });
    const vol = resolveTarget(p, target, () => undefined)!;
    expect(vol.fromNormalized(0.8)).toBeCloseTo(1); // 80 % of fader travel is 0 dB
    expect(vol.toNormalized(1)).toBeCloseTo(0.8);
    const ch = makeInstrumentChannel('Lead', makePluginInstance('x.synth', 1, { cutoff: 1000 }));
    const q = produce(p, (d) => {
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
    });
    const specs = { cutoff: params.float(20, 20000, 1000, { scale: 'log' }) };
    const cut = resolveTarget(
      q,
      { kind: 'plugin', owner: { kind: 'channel', channelId: ch.id }, paramId: 'cutoff' },
      () => specs,
    )!;
    expect(cut.base).toBe(1000);
    expect(cut.fromNormalized(0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
    const tempo = resolveTarget(q, { kind: 'tempo' }, () => undefined, { min: 100, max: 200 })!;
    expect(tempo.fromNormalized(0.25)).toBe(125);
    expect(
      resolveTarget(q, { kind: 'channel', channelId: 'ch_gone' as ChannelId, param: 'pan' }, () => undefined),
    ).toBeNull();
  });
});

describe('tempoMapOf', () => {
  it('uses the base tempo in pattern mode and tempo clips in song mode', () => {
    const p = withAutomation({ kind: 'tempo' }, [pt(0, 0), pt(3840, 1)], [{ start: 3840, length: 3840 }], {
      range: { min: 100, max: 200 },
    });
    expect(tempoMapOf(p, 'pattern').constant).toBe(true);
    const song = tempoMapOf(p, 'song');
    expect(song.bpmAt(0)).toBe(p.transport.bpm);
    expect(song.bpmAt(3840)).toBe(100);
    expect(song.bpmAt(3840 + 1920)).toBeCloseTo(150, 0);
    expect(song.bpmAt(99_999)).toBe(200);
    expect(tempoMapOf(p, 'song')).toBe(song); // memoized
    const swung = produce(p, (d) => {
      d.transport.swing = 0.5;
    });
    expect(tempoMapOf(swung, 'song')).toBe(song); // same tempo → same map object
  });
});

