import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { ChannelId, PatternId, Project } from '@core/model/types';
import { addChannel, setChannelProp } from '@core/ops/channels';
import { setStep } from '@core/ops/notes';
import { PPQ } from '@core/time/ppq';
import { patternModeSource } from './events';
import { Transport, type TransportSink } from './transport';

type Call =
  | { t: 'on'; time: number; noteId: number; key: number }
  | { t: 'off'; time: number; noteId: number }
  | { t: 'all'; time: number };

function setup(steps = [0, 4, 8, 12], bpm = 120) {
  let project: Project = createEmptyProject();
  const ch = makeInstrumentChannel('Kick', makePluginInstance('x', 1, {}));
  const pid = project.patternOrder[0] as PatternId;
  project = produce(project, (d) => {
    d.transport.bpm = bpm;
    addChannel(d, ch);
    for (const s of steps) setStep(d, pid, ch.id, s, true, { rootKey: 60 });
  });
  const clock = { currentTime: 0 };
  const calls: Call[] = [];
  const sink: TransportSink = {
    noteOn: (_c, e) => calls.push({ t: 'on', time: e.time, noteId: e.noteId, key: e.key }),
    noteOff: (_c, e) => calls.push({ t: 'off', time: e.time, noteId: e.noteId }),
    allNotesOff: (time) => calls.push({ t: 'all', time }),
  };
  const spt = 60 / (bpm * PPQ);
  const model = (p: Project) => {
    const { source, length } = patternModeSource(p, pid);
    return { source, timeline: { spt, loop: { start: 0, end: length }, endTick: length } };
  };
  const m = model(project);
  const transport = new Transport(clock, sink, m.source, m.timeline);
  const run = (until: number) => {
    while (clock.currentTime < until) {
      clock.currentTime += 0.025;
      transport.pump();
    }
  };
  return { transport, clock, calls, run, model, project, pid, ch: ch.id as ChannelId };
}

describe('Transport', () => {
  it('plays a looping 4-on-the-floor pattern with exact times', () => {
    const { transport, calls, run } = setup();
    transport.start(0, 0.1);
    run(4.2); // 120 BPM: one bar = 2 s
    const ons = calls.filter((c) => c.t === 'on').map((c) => +c.time.toFixed(6));
    expect(ons.slice(0, 8)).toEqual([0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6]);
    // Every note gets a noteOff one step (0.125 s) later.
    const first = calls.find((c) => c.t === 'on')!;
    const off = calls.find((c) => c.t === 'off' && c.noteId === first.noteId)!;
    expect(off.time).toBeCloseTo(0.225, 9);
  });

  it('never dispatches events beyond the lookahead', () => {
    const { transport, clock, calls } = setup();
    transport.start(0, 0);
    for (let i = 0; i < 20; i++) {
      clock.currentTime += 0.025;
      transport.pump();
      const latest = Math.max(...calls.filter((c) => c.t === 'on').map((c) => c.time));
      expect(latest).toBeLessThanOrEqual(clock.currentTime + transport.lookahead + 1e-9);
    }
  });

  it('picks up a step added inside the scheduled window', () => {
    const s = setup([0]);
    s.transport.start(0, 0);
    s.run(0.3); // window now covers up to ~0.42 s
    const added = produce(s.project, (d) => setStep(d, s.pid, s.ch, 3, true, { rootKey: 60 })); // 0.375 s
    const m = s.model(added);
    s.transport.setModel(m.source, m.timeline);
    const on = s.calls.filter((c) => c.t === 'on').map((c) => +c.time.toFixed(6));
    expect(on).toContain(0.375);
  });

  it('cancels a pending note when its step is removed', () => {
    const s = setup([0, 3]);
    s.transport.start(0, 0);
    s.run(0.3);
    const pending = s.calls.filter((c) => c.t === 'on').find((c) => Math.abs(c.time - 0.375) < 1e-9)!;
    expect(pending).toBeDefined();
    const removed = produce(s.project, (d) => setStep(d, s.pid, s.ch, 3, false, { rootKey: 60 }));
    const m = s.model(removed);
    s.transport.setModel(m.source, m.timeline);
    const cancel = s.calls.find((c) => c.t === 'off' && c.noteId === pending.noteId && c.time <= pending.time);
    expect(cancel).toBeDefined();
    s.run(2.2);
    // Second bar: only the step at 0.
    const secondBar = s.calls.filter((c) => c.t === 'on' && c.time > 1.99 && c.time < 3.99).map((c) => c.time);
    expect(secondBar).toHaveLength(1);
    expect(secondBar[0]).toBeCloseTo(2, 9);
  });

  it('silences muted channels on re-anchor and stops cleanly', () => {
    const s = setup();
    s.transport.start(0, 0);
    s.run(0.5);
    const muted = produce(s.project, (d) => setChannelProp(d, s.ch, 'muted', true));
    const m = s.model(muted);
    s.transport.setModel(m.source, m.timeline);
    const count = s.calls.filter((c) => c.t === 'on').length;
    s.run(3);
    expect(s.calls.filter((c) => c.t === 'on').length).toBe(count);
    s.transport.stop();
    expect(s.calls[s.calls.length - 1]?.t).toBe('all');
    expect(s.transport.playing).toBe(false);
    expect(s.transport.pendingNotes).toBe(0);
  });

  it('applies tempo changes from the re-anchor point', () => {
    const s = setup([0, 4, 8, 12], 120);
    s.transport.start(0, 0);
    s.run(0.2);
    const faster = produce(s.project, (d) => {
      d.transport.bpm = 240;
    });
    const spt = 60 / (240 * PPQ);
    const { source, length } = patternModeSource(faster, s.pid);
    s.transport.setModel(source, { spt, loop: { start: 0, end: length }, endTick: length });
    s.run(1.5);
    const ons = s.calls.filter((c) => c.t === 'on').map((c) => +c.time.toFixed(4));
    // Step 4 (tick 960) was at 0.5 s at 120 BPM; at 240 BPM from t≈0.235 it lands much earlier.
    expect(ons[0]).toBe(0);
    expect(ons[1]).toBeLessThan(0.5);
    expect(ons[2]! - ons[1]!).toBeCloseTo(0.25, 3);
  });

  it('maps the audible time back to a tick', () => {
    const s = setup();
    s.transport.start(0, 0);
    s.run(0.6);
    expect(s.transport.positionAt(0.25)).toBeCloseTo(480, 6);
  });
});
