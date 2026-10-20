/**
 * Playback under stress with the real-time engine in headless Chrome: start/stop/seek spam, loop and
 * tempo changes while playing, an engine reboot (audio buffer setting) while playing. Nothing may get
 * stuck, go backwards, throw or turn into NaN.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ClipId, LaneId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNotes } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { Engine } from '@engine/engine';
import type { EngineApi, TransportView } from '@engine/api';
import { EngineHost } from '@app/engine-host';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import fm from '../../src/plugins/builtin/fm';
import threeOsc from '../../src/plugins/builtin/three-osc';
import { automate, pt } from '../helpers/automation';
import { kitProject, resolver } from '../helpers/fixtures';
import { retryWhenOverloaded } from '../helpers/overload';

const BAR = 3840;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A four-bar song: a kick pattern, plus a graph synth and an FM (worklet) synth each holding a long note. */
function song(): { project: Project; view: TransportView } {
  const { project: kit, patternId } = kitProject([{ generator: 'kit/kick', steps: [0, 4, 8, 12] }], 120);
  const project = produce(kit, (d) => {
    for (const def of [threeOsc, fm] as PluginDef[]) {
      const ch = makeInstrumentChannel(def.id, makePluginInstance(def.id, def.version, defaultValues(def.params)));
      addChannel(d, ch);
      addNotes(d, patternId, ch.id, [{ id: newId.note(), tick: 0, length: BAR, key: 60, velocity: 0.9 }]);
    }
    for (let b = 0; b < 4; b++)
      addClips(d, [
        {
          kind: 'pattern',
          id: `c${b}` as ClipId,
          laneId: d.playlist.laneOrder[0] as LaneId,
          start: b * BAR,
          length: BAR,
          patternId,
          offset: 0,
        },
      ]);
  });
  return { project, view: { mode: 'song', patternId, loop: null } };
}

const engines: EngineApi[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.dispose();
});

async function boot(project: Project, view: TransportView, hint: AudioContextLatencyCategory = 'interactive') {
  const faults: unknown[] = [];
  const engine = Engine.realtime({ plugins: resolver(threeOsc, fm), onPluginFault: (_o, _id, err) => faults.push(err) }, hint);
  engines.push(engine);
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  engine.setTransportView(view);
  await engine.resume();
  await engine.ready();
  return { engine, faults };
}

/** Loudest sample the master carried over the last analyser window. */
function outputPeak(engine: EngineApi): number {
  const buf = new Float32Array(2048);
  engine.outputTap().waveform(buf, 0);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** Waits (polling) until `ok()`; fails after `ms`. */
async function until(ok: () => boolean, ms: number, what: string) {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('engine under stress', { tags: ['realtime'] }, () => {
  it('start/stop/seek spam leaves no stuck notes and no faults', async () => {
    const { project, view } = song();
    const { engine, faults } = await boot(project, view);
    engine.outputTap(); // attach the analyser before any sound
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 80; i++) {
      const r = rnd();
      if (r < 0.3) engine.stop();
      else engine.play(Math.floor(rnd() * 4 * BAR));
      await sleep(Math.floor(rnd() * 40));
    }
    // It really played at some point.
    engine.play(0);
    await until(() => outputPeak(engine) > 0.01, 3000, 'sound');
    engine.stop();
    // Everything released: no pending note, and silence once the (short) releases and tails are over.
    expect((engine as unknown as { transport: { pendingNotes: number } }).transport.pendingNotes).toBe(0);
    await until(() => outputPeak(engine) < 1e-3, 4000, 'silence after stop');
    expect(engine.playing).toBe(false);
    expect(faults).toEqual([]);
    expect(engine.stats().faults).toBe(0);
  }, 60_000);

  it('the playhead never goes backwards while a song plays', { timeout: 120_000 }, async (test) => {
    await retryWhenOverloaded(test, async () => {
      for (const e of engines.splice(0)) await e.dispose(); // an earlier attempt's engine
      const { project, view } = song();
      const { engine } = await boot(project, view);
      engine.play(0);
      let last = -1;
      const end = performance.now() + 2500;
      let samples = 0;
      while (performance.now() < end) {
        const p = engine.playhead();
        expect(p).toBeGreaterThanOrEqual(last);
        last = p;
        samples++;
        await sleep(7);
      }
      expect(samples).toBeGreaterThan(100);
      // About 2.5 s at 120 BPM = 5 beats; a stalled or runaway clock would be far off.
      expect(last).toBeGreaterThan(2 * 960);
      expect(last).toBeLessThan(8 * 960);
      engine.stop();
    });
  });

  it('moving the loop while playing keeps the playhead inside it, and clearing it plays on', { timeout: 120_000 }, async (test) => {
    await retryWhenOverloaded(test, async () => {
      for (const e of engines.splice(0)) await e.dispose(); // an earlier attempt's engine
      const { project, view } = song();
      const { engine } = await boot(project, view);
      engine.play(0);
      await sleep(300);
      const loop = { start: BAR, end: 2 * BAR };
      engine.setTransportView({ ...view, loop });
      await sleep(500);
      for (let i = 0; i < 40; i++) {
        const p = engine.playhead();
        expect(p).toBeGreaterThanOrEqual(loop.start - 1);
        expect(p).toBeLessThanOrEqual(loop.end + 1);
        await sleep(25);
      }
      // A different loop while inside the first one, then no loop at all.
      engine.setTransportView({ ...view, loop: { start: 2 * BAR, end: 3 * BAR } });
      await sleep(500);
      expect(engine.playhead()).toBeGreaterThanOrEqual(2 * BAR - 1);
      expect(engine.playhead()).toBeLessThanOrEqual(3 * BAR + 1);
      engine.setTransportView({ ...view, loop: null });
      const before = engine.playhead();
      await sleep(400);
      expect(engine.playhead()).not.toBe(before);
      expect(engine.playing).toBe(true);
      engine.stop();
    });
  });

  it('follows tempo automation while playing: the tempo rises and the playhead keeps up', { timeout: 120_000 }, async (test) => {
    await retryWhenOverloaded(test, async () => {
      for (const e of engines.splice(0)) await e.dispose(); // an earlier attempt's engine
      const { project: base, view } = song();
      // 60 → 180 BPM over the four bars (range 60–180).
      const { project } = automate(base, { kind: 'tempo' }, [pt(0, 0), pt(4 * BAR, 1)], [{ start: 0, length: 4 * BAR, lane: 1 }]);
      const { engine, faults } = await boot(project, view);
      engine.play(0);
      await sleep(500);
      const early = engine.tempoNow();
      const p1 = engine.playhead();
      await sleep(1500);
      const late = engine.tempoNow();
      const p2 = engine.playhead();
      expect(late).toBeGreaterThan(early);
      expect(p2).toBeGreaterThan(p1);
      // Seconds-per-tick integrates the ramp: 1.5 s at 60–100 BPM is about 1.5 to 2.2 beats, never 5+.
      expect((p2 - p1) / 960).toBeGreaterThan(1.2);
      expect((p2 - p1) / 960).toBeLessThan(3.5);
      engine.stop();
      expect(faults).toEqual([]);
    });
  });

  it('reports how well the audio keeps up, and stays sane across seeks', { timeout: 120_000 }, async (test) => {
    await retryWhenOverloaded(test, async () => {
      for (const e of engines.splice(0)) await e.dispose(); // an earlier attempt's engine
      const { project, view } = song();
      const { engine } = await boot(project, view);
      expect(engine.stats().keepUp).toBeUndefined();
      engine.play(0);
      await until(() => engine.stats().keepUp !== undefined, 4000, 'a keepUp measurement');
      const k = engine.stats().keepUp as number;
      expect(k).toBeGreaterThan(0.2);
      expect(k).toBeLessThanOrEqual(1);
      // The scheduler's longest wait is for this playback only.
      expect(engine.stats().maxPumpGapMs).toBeLessThan(1000);
      engine.stop();
      engine.play(0);
      expect(engine.stats().maxPumpGapMs).toBeLessThan(200);
      engine.stop();
    });
  });

  it('rebooting the engine (audio buffer setting) while playing carries on and the sound comes back', async () => {
    const { project, view } = song();
    const faults: unknown[] = [];
    let hint: AudioContextLatencyCategory = 'interactive';
    const host = new EngineHost(() => {
      const e = Engine.realtime({ plugins: resolver(threeOsc, fm), onPluginFault: (_o, _id, err) => faults.push(err) }, hint);
      return e;
    });
    engines.push(host);
    host.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    host.setTransportView(view);
    await host.resume();
    await host.ready();
    host.outputTap();
    host.play(BAR);
    await until(() => outputPeak(host) > 0.01, 4000, 'sound before the reboot');
    const stateBefore = host.stats();
    expect(stateBefore.state).toBe('running');
    hint = 'playback';
    await host.reboot();
    expect(host.playing).toBe(true);
    // The synths started after loading, so a held note is heard soon after the reboot, from near where it was.
    await until(() => outputPeak(host) > 0.01, 4000, 'sound after the reboot');
    expect(host.playhead()).toBeGreaterThanOrEqual(BAR - 1);
    // A second request during a reboot is not lost.
    hint = 'balanced';
    const a = host.reboot();
    hint = 'interactive';
    const b = host.reboot();
    await Promise.all([a, b]);
    expect(host.playing).toBe(true);
    await until(() => outputPeak(host) > 0.01, 4000, 'sound after the second reboot');
    host.stop();
    expect(faults).toEqual([]);
  }, 60_000);
});
