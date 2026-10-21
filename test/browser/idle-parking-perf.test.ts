/**
 * What idle parking buys and what it must not cost (src/engine/idle-parking.ts), measured in a live engine:
 *  - the very big project (`?perf=huge`: 200 channels, 100 tracks, 453 AudioWorklet kernels) used to keep the audio thread at
 *    its limit with nothing playing; parked, it idles at a few percent (the audio thread's own account of its load, read
 *    through the DevTools protocol);
 *  - a note into a channel that was parked is heard no later than one into a channel that was awake: waking is a
 *    connection made on the very call that hands the note over, so it must add under a millisecond to the engine's part of
 *    the key-to-sound time (`npm run test:perf` holds that limit; the regular run keeps a loose one).
 * The numbers are in docs/architecture.md, "Big projects".
 */
import { produce } from 'immer';
import { afterEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { defineWorkletInstrument, p } from '@agstudio/sdk';
import { addInstrumentChannel } from '@app/actions/channels';
import { buildHugeSong, HUGE_SIZE } from '@app/fixtures/huge-song';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { memoryPresetStorage } from '@app/presets';
import { createServices, type Services } from '@app/services';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { ChannelId, Project } from '@core/model/types';
import { Engine } from '@engine/engine';
import { innerEngine, measure, Probe, summarize } from '../helpers/latency';
import { perfLimit } from '../helpers/perf';
import processor from './latency-tone.worklet.ts?worker&url';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rigs: Services[] = [];
afterEach(async () => {
  for (const s of rigs.splice(0)) await s.engine.dispose();
});

function hugeProject(): Project {
  const previous = setIdSource(seededBytes(11));
  try {
    return produce(createEmptyProject({ now: new Date(0) }), (draft) => void buildHugeSong(draft, HUGE_SIZE));
  } finally {
    setIdSource(previous);
  }
}

/** How much of its time the audio thread spent rendering, averaged over `seconds` (the protocol's render capacity, 0-1). */
async function audioThreadLoad(contextId: string, seconds: number): Promise<number> {
  const readings: number[] = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    await sleep(500);
    const { realtimeData } = (await cdp().send('WebAudio.getRealtimeData', { contextId })) as { realtimeData: { renderCapacity: number } };
    readings.push(realtimeData.renderCapacity);
  }
  return readings.reduce((sum, x) => sum + x, 0) / readings.length;
}

describe('idle parking, measured', { tags: ['perf', 'realtime'] }, () => {
  it('the very big project idles at a small share of the audio thread', { timeout: 300_000 }, async () => {
    const contexts: string[] = [];
    await cdp().send('WebAudio.enable');
    cdp().on('WebAudio.contextCreated', (event: { context: { contextId: string } }) => contexts.push(event.context.contextId));
    let engine!: Engine;
    const s = createServices({ project: hugeProject(), createEngine: (options) => (engine = Engine.realtime(options)) });
    rigs.push(s);
    await s.engine.resume();
    await s.engine.ready();
    const total = engine.stats().parked;
    expect(total).toBeDefined();
    // Every kernel has slept a second and every channel and track has been looked at: all of them are out of the graph.
    await expect
      .poll(() => engine.stats().parked, { timeout: 60_000, interval: 250 })
      .toEqual({ channels: Object.values(s.doc.getState().project.channels).filter((c) => c.kind !== 'automation').length, inserts: 100 });
    const load = await audioThreadLoad(contexts[contexts.length - 1] as string, 5);
    console.log(`PARK | huge project idle: audio thread at ${(load * 100).toFixed(1)} %`);
    // It was 100 % (and the audio clock lost time) before parking.
    expect(load).toBeLessThan(perfLimit(0.15, 0.6));
  });

  it('a note into a parked channel is heard no later than one into a channel that was awake', { timeout: 300_000 }, async () => {
    const tone = defineWorkletInstrument({ id: 'test.latency-tone', name: 'Latency tone', version: 1, params: { level: p.float(0, 1, 1) }, processor, tailTime: 0.05 });
    const plugins = new PluginRegistry();
    registerBuiltinPlugins(plugins);
    plugins.sync('user', [{ path: 'test/latency-tone', def: tone }]);
    const s = createServices({ plugins, project: createEmptyProject(), presetStorage: memoryPresetStorage() });
    rigs.push(s);
    const channel = addInstrumentChannel(s, 'test.latency-tone') as ChannelId;
    await s.engine.resume();
    await s.engine.ready();
    const engine = innerEngine(s.engine);
    const probe = await Probe.attach(engine);
    const trigger = {
      fire(mark: () => void) {
        const t0 = performance.now();
        mark();
        const noteId = engine.previewNoteOn(channel, 60, 1);
        setTimeout(() => engine.previewNoteOff(channel, noteId), 20);
        return t0;
      },
    };
    const transits = async (runs: number, beforeEach: () => Promise<void>): Promise<number[]> => {
      const out: number[] = [];
      // The first runs warm the engine up (the first output timestamps of a context are not valid yet): not counted.
      for (let i = -2; i < runs; i++) {
        await beforeEach();
        const sample = await measure(probe, engine.ctx as AudioContext, trigger);
        if (i >= 0 && sample) out.push(sample.transit);
        await sleep(60 + ((i * 7) % 13));
      }
      return out;
    };
    const awake = await transits(perfLimit(30, 8), async () => {
      expect(engine.stats().parked?.channels).toBe(0);
    });
    const parked = await transits(perfLimit(12, 4), async () => {
      // Silent for the second the kernel takes to fall asleep, then looked at by the next tick.
      await expect.poll(() => engine.stats().parked?.channels, { timeout: 20_000, interval: 100 }).toBe(1);
    });
    probe.dispose();
    const wakeCost = summarize(parked).median - summarize(awake).median;
    console.log(
      `PARK | live note, engine part of the key-to-sound time: awake median ${summarize(awake).median.toFixed(2)} ms (n=${awake.length}), parked median ${summarize(parked).median.toFixed(2)} ms (n=${parked.length}), difference ${wakeCost.toFixed(2)} ms`,
    );
    expect(parked.length).toBeGreaterThan(0);
    expect(wakeCost).toBeLessThan(perfLimit(1, 4));
  });
});
