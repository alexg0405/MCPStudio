/**
 * What an audio buffer change costs while a song plays, and whether Auto keeps a busy song smooth (real services and
 * engine in headless Chrome). A held tone plays through the heavy `?perf=mix30` song (its tracks muted); the master
 * output is watched across `EngineHost.reboot()` (the step Auto takes) for the longest stretch of silence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addInstrumentChannel } from '@app/actions/channels';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { memoryPresetStorage } from '@app/presets';
import { createServices, type Services } from '@app/services';
import { createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ChannelId, PatternId } from '@core/model/types';
import { setInsertProp } from '@core/ops/mixer';
import { addNote } from '@core/ops/notes';
import { defineWorkletInstrument, p } from '@agstudio/sdk';
import { registerFeatures } from '@ui/features';
import { applyPerfFixture } from '@ui/perf-fixtures';
import { perfLimit, STRICT_PERF } from '../helpers/perf';
import processor from './latency-tone.worklet.ts?worker&url';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tone = defineWorkletInstrument({
  id: 'test.latency-tone',
  name: 'Latency tone',
  version: 1,
  params: { level: p.float(0, 1, 1) },
  processor,
  tailTime: 0.05,
});

const services: Services[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.engine.dispose();
  localStorage.clear();
});

async function boot(prefs: object, heavy: boolean): Promise<Services> {
  localStorage.setItem('agstudio:prefs:v1', JSON.stringify(prefs));
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  plugins.sync('user', [{ path: 'test/latency-tone', def: tone }]);
  const s = createServices({ plugins, project: createEmptyProject(), presetStorage: memoryPresetStorage() });
  services.push(s);
  registerFeatures(s);
  const pattern = s.view.getState().currentPatternId as PatternId;
  if (heavy) {
    applyPerfFixture(s, 'mix30');
    const inserts = s.doc.getState().project.mixer.order.slice(1);
    s.history.transact('Mute the mix', (d) => {
      for (const id of inserts) setInsertProp(d, id, 'muted', true);
    });
  }
  const channel = addInstrumentChannel(s, 'test.latency-tone') as ChannelId;
  // A tone that never stops, in 1/32 notes end to end (a note that rings across the reboot is not played again by the
  // new engine: it joins at the next note), looping.
  const length = heavy ? 4 * 3840 : 3840;
  s.history.transact('Tone', (d) => {
    for (let tick = 0; tick < length; tick += 120)
      addNote(d, pattern, channel, { id: newId.note(), tick, length: 120, key: 60, velocity: 1 });
  });
  await s.engine.resume();
  await s.engine.ready();
  return s;
}

/** Longest run (ms) the master carried nothing while `during` ran, polling its newest few milliseconds. */
async function longestSilence(s: Services, during: () => Promise<void>): Promise<number> {
  const tap = s.engine.outputTap();
  const buf = new Float32Array(192);
  let longest = 0;
  let lastLoud = performance.now();
  let done = false;
  const run = during().then(() => sleep(400)).then(() => void (done = true));
  while (!done) {
    tap.waveform(buf, 0);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const now = performance.now();
    if (peak > 0.02) {
      longest = Math.max(longest, now - lastLoud);
      lastLoud = now;
    }
    await sleep(1);
  }
  await run;
  return Math.max(longest, performance.now() - lastLoud);
}

describe('audio buffer changes while playing', () => {
  it('the song plays on through a reboot: the longest silence is short', { tags: ['perf'], timeout: 120_000 }, async () => {
    const s = await boot({ audioBuffer: 'auto', autoBufferSize: 'small' }, true);
    s.engine.outputTap();
    s.engine.play(0);
    await sleep(1500);
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      gaps.push(await longestSilence(s, () => (s.engine as unknown as { reboot(): Promise<void> }).reboot()));
      await sleep(500);
      expect(s.engine.playing).toBe(true);
    }
    console.log(`LAT | reboot while the heavy song plays: longest silence ${gaps.map((g) => g.toFixed(0)).join(', ')} ms`);
    expect(Math.max(...gaps)).toBeLessThan(perfLimit(150, 1500));
  });

  it('Auto keeps the heavy song smooth', { tags: ['perf'], timeout: 120_000 }, async () => {
    const s = await boot({ audioBuffer: 'auto', autoBufferSize: 'small' }, true);
    s.engine.play(0);
    const keep: number[] = [];
    const end = performance.now() + perfLimit(20_000, 6000);
    while (performance.now() < end) {
      await sleep(1000);
      const k = s.engine.stats().keepUp;
      if (k !== undefined) keep.push(k);
    }
    const st = s.engine.stats();
    console.log(
      `LAT | Auto, heavy song: keepUp min ${Math.min(...keep).toFixed(3)} over ${keep.length} s, late events ${st.lateEvents}, buffer now ${s.prefs.getState().autoBufferSize}`,
    );
    // The regular run shares the cores with every other test file: only the strict run holds the limit.
    if (STRICT_PERF) expect(Math.min(...keep)).toBeGreaterThanOrEqual(0.98);
    if (STRICT_PERF) expect(st.lateEvents).toBe(0);
  });
});
