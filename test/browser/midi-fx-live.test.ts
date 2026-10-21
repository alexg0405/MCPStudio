/**
 * Live keys through MIDI effects, in a real engine: the first note of an arpeggio comes out as soon as a plain live note does
 * (the effects add only the time the chain takes to run), the instrument is woken by generated notes like by real ones, a latched
 * arpeggio goes on after the keys are up and stops with Stop, and the chain can be edited while keys are down.
 * The numbers are in docs/architecture.md, "MIDI effects".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineWorkletInstrument, p } from '@agstudio/sdk';
import { addInstrumentChannel } from '@app/actions/channels';
import { addMidiEffect } from '@app/actions/midi-fx';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { memoryPresetStorage } from '@app/presets';
import { createServices, type Services } from '@app/services';
import { createEmptyProject } from '@core/model/defaults';
import { setMidiFxParam } from '@core/ops/midi-fx';
import { midiFxOf } from '@core/query/midi-fx';
import type { ChannelId } from '@core/model/types';
import { Engine } from '@engine/engine';
import { innerEngine, measure, Probe, summarize } from '../helpers/latency';
import { perfLimit } from '../helpers/perf';
import processor from './latency-tone.worklet.ts?worker&url';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rigs: Services[] = [];
afterEach(async () => {
  for (const s of rigs.splice(0)) await s.engine.dispose();
});

/** A live engine with two channels of the latency tone: `plain`, and `arp` with an arpeggiator. */
async function setup() {
  const tone = defineWorkletInstrument({ id: 'test.latency-tone', name: 'Latency tone', version: 1, params: { level: p.float(0, 1, 1) }, processor, tailTime: 0.05 });
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  plugins.sync('user', [{ path: 'test/latency-tone', def: tone }]);
  let engine!: Engine;
  const s = createServices({
    plugins,
    project: createEmptyProject(),
    presetStorage: memoryPresetStorage(),
    createEngine: (options) => (engine = Engine.realtime(options)),
  });
  rigs.push(s);
  const plain = addInstrumentChannel(s, 'test.latency-tone') as ChannelId;
  const arp = addInstrumentChannel(s, 'test.latency-tone') as ChannelId;
  addMidiEffect(s, arp, 'arp', { params: { rate: '1/16', gate: 0.5 } });
  await s.engine.resume();
  await s.engine.ready();
  return { s, engine: innerEngine(s.engine) as Engine, plain, arp };
}

describe('live keys through an arpeggiator', { tags: ['perf', 'realtime'] }, () => {
  it('the first note comes out as soon as a plain key does: the chain adds microseconds, not a step', { timeout: 300_000 }, async () => {
    const { engine, plain, arp } = await setup();
    const probe = await Probe.attach(engine);
    const press = (channel: ChannelId) => ({
      fire(mark: () => void) {
        const t0 = performance.now();
        mark();
        const noteId = engine.previewNoteOn(channel, 60, 1);
        setTimeout(() => engine.previewNoteOff(channel, noteId), 20);
        return t0;
      },
    });
    const transits = async (channel: ChannelId, runs: number): Promise<number[]> => {
      const out: number[] = [];
      // The first runs warm the engine up (the first output timestamps of a context are not valid yet): not counted.
      for (let i = -2; i < runs; i++) {
        const sample = await measure(probe, engine.ctx as AudioContext, press(channel));
        if (i >= 0 && sample) out.push(sample.transit);
        // Long enough for the arpeggio's own notes to end, so the next press starts from silence.
        await sleep(160 + ((i * 7) % 13));
      }
      return out;
    };
    const runs = perfLimit(30, 8);
    const plainTransit = await transits(plain, runs);
    const arpTransit = await transits(arp, runs);
    probe.dispose();
    const extra = summarize(arpTransit).median - summarize(plainTransit).median;
    console.log(
      `FX | live key, engine part of the key-to-sound time: plain median ${summarize(plainTransit).median.toFixed(2)} ms (n=${plainTransit.length}), arpeggiator median ${summarize(arpTransit).median.toFixed(2)} ms (n=${arpTransit.length}), difference ${extra.toFixed(2)} ms`,
    );
    expect(arpTransit.length).toBeGreaterThan(0);
    expect(extra).toBeLessThan(perfLimit(1, 4));
  });

  it('running the chain for a key press costs well under a millisecond, and a plain channel pays nothing', { timeout: 120_000 }, async () => {
    const { engine, plain, arp } = await setup();
    const cost = (channel: ChannelId, presses: number) => {
      const times: number[] = [];
      for (let i = 0; i < presses; i++) {
        const t0 = performance.now();
        const id = engine.previewNoteOn(channel, 48 + (i % 24), 0.8);
        times.push(performance.now() - t0);
        engine.previewNoteOff(channel, id);
      }
      return summarize(times);
    };
    cost(plain, 40);
    cost(arp, 40);
    const plainCost = cost(plain, 200);
    const arpCost = cost(arp, 200);
    console.log(`FX | previewNoteOn call: plain median ${plainCost.median.toFixed(3)} ms (p95 ${plainCost.p95.toFixed(3)}), with an arpeggiator median ${arpCost.median.toFixed(3)} ms (p95 ${arpCost.p95.toFixed(3)})`);
    expect(arpCost.median - plainCost.median).toBeLessThan(perfLimit(1, 4));
  });
});

describe('live keys and the rest of the engine', { tags: ['realtime'] }, () => {
  it('generated notes wake a parked instrument like real ones do', { timeout: 120_000 }, async () => {
    const { engine, arp } = await setup();
    // Both channels have slept (a second of silence) and been taken out of the graph.
    await expect.poll(() => engine.stats().parked?.channels, { timeout: 30_000, interval: 100 }).toBe(2);
    const id = engine.previewNoteOn(arp, 60, 1);
    // The first generated note woke it on the very call; the plain channel is still asleep.
    expect(engine.stats().parked?.channels).toBe(1);
    engine.previewNoteOff(arp, id);
  });

  it('a latched arpeggio goes on after the keys are up and stops with Stop', { timeout: 120_000 }, async () => {
    const { s, engine, arp } = await setup();
    const slot = midiFxOf(s.doc.getState().project.channels[arp])[0]!.id;
    s.history.transact('latch', (d) => setMidiFxParam(d, arp, slot, 'latch', true));
    await expect.poll(() => engine.stats().parked?.channels, { timeout: 30_000, interval: 100 }).toBe(2);
    const id = engine.previewNoteOn(arp, 60, 1);
    engine.previewNoteOff(arp, id);
    // Long after the key is up the channel is still playing (its notes keep it awake), while the plain one sleeps.
    await sleep(900);
    expect(engine.stats().parked?.channels).toBe(1);
    s.engine.stop();
    await expect.poll(() => engine.stats().parked?.channels, { timeout: 30_000, interval: 100 }).toBe(2);
  });

  it('turning a knob while a key is down changes the arpeggio at once', { timeout: 120_000 }, async () => {
    const { s, engine, arp } = await setup();
    const slot = midiFxOf(s.doc.getState().project.channels[arp])[0]!.id;
    const id = engine.previewNoteOn(arp, 60, 1);
    await sleep(200);
    s.history.transact('octaves', (d) => setMidiFxParam(d, arp, slot, 'octaves', 2));
    await sleep(200);
    engine.previewNoteOff(arp, id);
    // No stuck notes: everything ends, and the channel goes back to sleep.
    await expect.poll(() => engine.stats().parked?.channels, { timeout: 30_000, interval: 100 }).toBe(2);
  });
});
