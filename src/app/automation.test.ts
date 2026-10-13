import { beforeEach, describe, expect, it } from 'vitest';
import { automationModelOf } from '@core/automation/model';
import { seededBytes, setIdSource } from '@core/model/ids';
import { targetKey } from '@core/model/targets';
import type { AutomationChannel, ChannelId, ParamTarget, Project } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { setBpm } from '@core/ops/notes';
import { createTestServices } from './testing';
import { tempoRange } from './automation';
import type { AutomationStatus } from './automation';

beforeEach(() => setIdSource(seededBytes(21)));

function setup() {
  const s = createTestServices();
  const p = s.doc.getState().project;
  const ch = p.channelOrder.find((id) => p.channels[id]?.kind === 'instrument') as ChannelId;
  return { s, ch, vol: { kind: 'channel', channelId: ch, param: 'volume' } as ParamTarget };
}

const automations = (p: Project) =>
  p.channelOrder.map((id) => p.channels[id]).filter((c): c is AutomationChannel => c?.kind === 'automation');

describe('AutomationService', () => {
  it('creates a named clip at the loop region (or 4 bars at the song position), one undo step', () => {
    const { s, ch, vol } = setup();
    s.view.getState().setSongStart(3840 + 500);
    const made = s.automation.createClip(vol)!;
    let p = s.doc.getState().project;
    const auto = p.channels[made.channelId] as AutomationChannel;
    expect(auto.name).toBe(`Volume · ${p.channels[ch]!.name}`);
    expect(p.playlist.clips[made.clipId]).toMatchObject({ start: 3840, length: 4 * 3840 });
    // Two points at the channel's current volume (0.78 of 1.25).
    expect(auto.points.map((x) => x.value)).toEqual([0.78 / 1.25, 0.78 / 1.25].map((v) => expect.closeTo(v, 9)));
    expect(s.editor.getState().clipSelection).toEqual([made.clipId]);
    expect(s.history.status().undoLabel).toBe('Create automation clip');
    s.view.getState().setLoop({ start: 1920, end: 5760 });
    const second = s.automation.createClip(vol)!;
    p = s.doc.getState().project;
    expect(p.playlist.clips[second.clipId]).toMatchObject({ start: 1920, length: 3840 });
    expect(second.laneId).not.toBe(made.laneId);
    s.history.undo();
    s.history.undo();
    expect(automations(s.doc.getState().project)).toHaveLength(0);
  });

  it('makes tempo clips spanning 60–180 BPM, wider when the tempo is outside', () => {
    const { s } = setup();
    s.history.transact('Tempo', (d) => setBpm(d, 200));
    const made = s.automation.createClip({ kind: 'tempo' })!;
    const auto = s.doc.getState().project.channels[made.channelId] as AutomationChannel;
    expect(auto.name).toBe('Tempo');
    expect(auto.range).toEqual({ min: 60, max: 210 });
    expect(auto.points[0]!.value).toBeCloseTo((200 - 60) / 150, 9);
    expect(tempoRange(120)).toEqual({ min: 60, max: 180 });
    expect(tempoRange(45)).toEqual({ min: 30, max: 180 });
  });

  it('lets automation go of a control while it is dragged', () => {
    const { s, ch, vol } = setup();
    const key = targetKey(vol);
    const g = s.history.gesture('Channel volume');
    g.update((d) => setChannelProp(d, ch, 'volume', 0.5));
    expect(s.fakeEngine.touched.has(key)).toBe(true);
    g.update((d) => setChannelProp(d, ch, 'volume', 0.6));
    g.commit();
    expect(s.fakeEngine.touched.has(key)).toBe(false);
    // Typed values and undo don't touch.
    s.history.transact('Volume', (d) => setChannelProp(d, ch, 'volume', 0.2));
    s.history.undo();
    expect(s.fakeEngine.touched.size).toBe(0);
    // A cancelled drag lets go too.
    const g2 = s.history.gesture('Channel volume');
    g2.update((d) => setChannelProp(d, ch, 'volume', 0.9));
    g2.cancel();
    expect(s.fakeEngine.touched.size).toBe(0);
  });

  it('records knob moves into a new clip, thinned, one undo step per take', () => {
    const { s, ch, vol } = setup();
    const key = targetKey(vol);
    s.view.getState().setMode('song');
    let tick = 0;
    s.fakeEngine.playhead = () => tick;
    s.recording.setArmed(true);
    s.engine.play();
    expect(s.automation.recording).toBe(true);
    const g = s.history.gesture('Channel volume');
    // A ramp from 0.25 to 1.0 over beats 2–4 of bar 2, then held.
    for (let i = 0; i <= 60; i++) {
      tick = 3840 + 960 + i * 32;
      g.update((d) => setChannelProp(d, ch, 'volume', 0.25 + (0.75 * i) / 60));
    }
    expect(s.fakeEngine.touched.has(key)).toBe(true);
    g.commit();
    // Latched until the take ends.
    expect(s.fakeEngine.touched.has(key)).toBe(true);
    const statuses: (AutomationStatus | null)[] = [];
    const off = s.automation.watch(key, (st) => statuses.push(st));
    expect(statuses.at(-1)?.kind).toBe('recording');
    s.engine.stop();
    expect(s.fakeEngine.touched.has(key)).toBe(false);
    expect(s.history.status().undoLabel).toBe('Record automation');
    const p = s.doc.getState().project;
    const [auto] = automations(p);
    expect(auto?.target).toEqual(vol);
    const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'automation')!;
    expect(clip).toMatchObject({ start: 3840, length: 3840 });
    // Thinned: a straight ramp keeps only its corners (plus the value before the move).
    expect(auto!.points.length).toBeLessThanOrEqual(6);
    const ta = automationModelOf(p).targets.get(key)!;
    expect(ta.spans[0]!.points).toBe(auto!.points);
    const at = (t: number) => {
      const pts = auto!.points;
      let v = pts[0]!.value;
      for (let i = 0; i + 1 < pts.length; i++)
        if (t >= pts[i]!.tick && t <= pts[i + 1]!.tick && pts[i + 1]!.tick > pts[i]!.tick)
          v = pts[i]!.value + ((pts[i + 1]!.value - pts[i]!.value) * (t - pts[i]!.tick)) / (pts[i + 1]!.tick - pts[i]!.tick);
        else if (t > pts[i + 1]!.tick) v = pts[i + 1]!.value;
      return v * 1.25;
    };
    expect(at(960 + 30 * 32)).toBeCloseTo(0.25 + 0.375, 2);
    expect(at(3800)).toBeCloseTo(1, 2);
    expect(statuses.at(-1)?.kind).toBe('automated');
    off();
    s.history.undo();
    expect(automations(s.doc.getState().project)).toHaveLength(0);
  });

  it('records into the clip that covers the take, keeping the curve around it', () => {
    const { s, ch, vol } = setup();
    s.view.getState().setMode('song');
    s.view.getState().setSongStart(0);
    const made = s.automation.createClip(vol)!;
    let tick = 0;
    s.fakeEngine.playhead = () => tick;
    s.recording.setArmed(true);
    s.engine.play();
    const g = s.history.gesture('Channel volume');
    for (let i = 0; i <= 10; i++) {
      tick = 3840 + i * 96;
      g.update((d) => setChannelProp(d, ch, 'volume', 1.25));
    }
    g.commit();
    s.engine.stop();
    const p = s.doc.getState().project;
    expect(automations(p)).toHaveLength(1);
    const pts = (p.channels[made.channelId] as AutomationChannel).points;
    const base = 0.78 / 1.25;
    expect(pts[0]).toEqual({ tick: 0, value: expect.closeTo(base, 9) });
    expect(pts.some((x) => x.value === 1)).toBe(true);
    expect(pts.at(-1)!.value).toBeCloseTo(base, 9);
  });

  it('reports automated targets to controls (and stops when the clip goes)', () => {
    const { s, vol } = setup();
    const key = targetKey(vol);
    const seen: (AutomationStatus | null)[] = [];
    s.automation.watch(key, (st) => seen.push(st));
    expect(seen).toEqual([null]);
    s.automation.createClip(vol);
    expect(seen.at(-1)).toMatchObject({ kind: 'automated' });
    expect(seen.at(-1)!.hint).toMatch(/^Automated by clip ‘Volume · .+’ – right-click to edit$/);
    s.history.undo();
    expect(seen.at(-1)).toBeNull();
    expect(seen).toHaveLength(3);
  });
});
