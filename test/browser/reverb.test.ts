/**
 * The Reverb's engines in Chrome: the algorithmic engine (the default) must be cheap enough that a
 * song with ten long reverbs plays in real time and exports fast, and it must sound like a reverb.
 */
import { describe, expect, it } from 'vitest';
import type { PatternId, Project } from '@core/model/types';
import { Engine } from '@engine/engine';
import { renderOffline } from '@engine/render-offline';
import type { ParamValue, PluginDef } from '@agstudio/sdk';
import reverb from '../../src/plugins/builtin/reverb';
import processor from '../../src/plugins/builtin/reverb/reverb.worklet.ts?worker&url';
import { REVERB_ID } from '../../src/plugins/builtin/reverb/params';
import { kitProject, resolver, withInsert, type FxSpec } from '../helpers/fixtures';
import { perfLimit, settle } from '../helpers/perf';
import { rmsRange } from '../helpers/routing';

const SR = 48000;
const plugins = resolver();

/** A drum loop through `count` reverbs in a row (one insert has ten slots). */
function reverbs(count: number, params: Record<string, ParamValue>) {
  const { project, patternId, channels } = kitProject([
    { generator: 'kit/kick', steps: [0, 8] },
    { generator: 'kit/snare', steps: [4, 12] },
    { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
  ]);
  const fx: FxSpec[] = Array.from({ length: count }, () => ({ def: reverb as PluginDef, params }));
  return { project: withInsert(project, channels, { fx }).project, patternId };
}

async function render(project: Project, patternId: PatternId, bars: number, tail: number | 'auto' = 1) {
  return renderOffline(project, {
    plugins,
    view: { mode: 'pattern', patternId, loop: null },
    bars,
    sampleRate: SR,
    tail,
  });
}

/** Seconds of audio per second of rendering. */
async function speed(project: Project, patternId: PatternId, bars: number): Promise<number> {
  const t0 = performance.now();
  const { buffer } = await render(project, patternId, bars);
  return buffer.duration / ((performance.now() - t0) / 1000);
}

const LONG = { decay: 7, size: 1, damping: 0.5, mix: 0.3 };

describe('Reverb engines', () => {
  it('ten 7 s algorithmic reverbs render offline at least 15× faster than real time', { tags: ['perf'] }, async () => {
    // The reverbs alone: ten processors (as the plugin creates them) on drum-like noise bursts. Each
    // context compiles the kernel afresh, so the render is long enough for the JIT warm-up not to
    // count much; the best of up to three renders (stopping at the first fast enough), as the machine's
    // hiccups only ever add time. 15× holds on a quiet machine (`npm run test:perf`); the regular run
    // shares the cores with the whole suite and only asks for 4×.
    const limit = perfLimit(15, 4);
    const seconds = 20;
    const once = async () => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: seconds * SR, sampleRate: SR });
      await ctx.audioWorklet.addModule(processor);
      const hits = new AudioBuffer({ numberOfChannels: 2, length: SR / 2, sampleRate: SR });
      for (let c = 0; c < 2; c++) {
        const d = hits.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (0.03 * SR)) * 0.5;
      }
      const source = new AudioBufferSourceNode(ctx, { buffer: hits, loop: true });
      for (let k = 0; k < 10; k++) {
        const node = new AudioWorkletNode(ctx, REVERB_ID, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          parameterData: { preDelay: 0.02, mix: 0.3 },
          processorOptions: {
            kind: 'effect',
            state: undefined,
            seed: k + 1,
            params: { decay: 7, damping: 0.5, size: 1, engine: 0 },
          },
        });
        source.connect(node).connect(ctx.destination);
      }
      source.start();
      const t0 = performance.now();
      const out = await ctx.startRendering();
      expect(rmsRange(out, SR, 2 * SR)).toBeGreaterThan(0.01);
      return seconds / ((performance.now() - t0) / 1000);
    };
    const factor = await settle(once, (f) => f > limit, { attempts: 3, better: 'higher' });
    console.info(`[reverb] 10 × 7 s algorithmic reverbs offline: ${factor.toFixed(1)}× real time`);
    expect(factor).toBeGreaterThan(limit);
  });

  it('a song with ten 7 s reverbs exports several times faster than with the convolution engine', async () => {
    const algo = reverbs(10, { ...LONG, engine: 'algorithmic' });
    const conv = reverbs(10, { ...LONG, engine: 'convolution' });
    const dry = reverbs(0, {});
    await render(algo.project, algo.patternId, 0.25); // warm up the worklet module and the JIT
    await render(conv.project, conv.patternId, 0.25); // and the impulse response (cached after)
    const algoSpeed = await speed(algo.project, algo.patternId, 4);
    const convSpeed = await speed(conv.project, conv.patternId, 2);
    const drySpeed = await speed(dry.project, dry.patternId, 4);
    // Ten effect slots of any kind cost the engine about as much as these reverbs (their gain stages
    // and the worklet calls): ten Choruses render at about the same speed.
    console.info(
      `[reverb] a drum loop through 10 × 7 s reverb slots, offline: algorithmic ${algoSpeed.toFixed(1)}× real ` +
        `time, convolution ${convSpeed.toFixed(1)}×, no reverb ${drySpeed.toFixed(1)}×`,
    );
    expect(algoSpeed).toBeGreaterThan(4 * convSpeed);
  }, 120_000);

  it('ten 7 s algorithmic reverbs keep the realtime audio clock at real time', { tags: ['perf'] }, async () => {
    const rate = async (engineName: string) => {
      const { project, patternId } = reverbs(10, { ...LONG, engine: engineName });
      const engine = Engine.realtime({ plugins });
      const ctx = engine.ctx as AudioContext;
      try {
        engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
        engine.setTransportView({ mode: 'pattern', patternId, loop: null });
        await engine.ready();
        await engine.resume();
        engine.play(0);
        // Let the tails build up, then time the audio clock against the wall clock.
        await new Promise((r) => setTimeout(r, 1000));
        const c0 = ctx.currentTime;
        const w0 = performance.now();
        await new Promise((r) => setTimeout(r, 2500));
        return (ctx.currentTime - c0) / ((performance.now() - w0) / 1000);
      } finally {
        engine.stop();
        await engine.dispose();
      }
    };
    const limit = perfLimit(0.95, 0.7);
    const algo = await settle(() => rate('algorithmic'), (r) => r > limit, { attempts: 3, better: 'higher' });
    const conv = await rate('convolution');
    console.info(
      `[reverb] 10 × 7 s realtime: the audio clock runs at ${algo.toFixed(2)}× (algorithmic), ` +
        `${conv.toFixed(2)}× (convolution)`,
    );
    expect(algo).toBeGreaterThan(limit);
  });

  it('sounds: a snare rings out, decays and stops; the tail is reported for exports', async () => {
    const { project, patternId, channels } = kitProject([{ generator: 'kit/snare', steps: [0] }]);
    const params = { decay: 2, size: 0.7, damping: 0.4, preDelay: 0.02, mix: 1 };
    const verb = withInsert(project, channels, { fx: [{ def: reverb as PluginDef, params }] }).project;
    const { buffer, preRoll } = await render(verb, patternId as PatternId, 0.5, 'auto');
    // The auto tail covers the decay: 1.3 × RT60 past the half bar.
    expect(buffer.duration).toBeGreaterThan(preRoll + 1 + 2 * 1.3);
    const at = (t: number) => Math.round((preRoll + t) * SR);
    const rms = (t0: number, t1: number) =>
      Math.max(rmsRange(buffer, at(t0), at(t1), 0), rmsRange(buffer, at(t0), at(t1), 1));
    const early = rms(0.05, 0.3);
    const mid = rms(1, 1.25);
    const late = rms(2.2, 2.45);
    expect(early).toBeGreaterThan(0.005);
    // About 60 dB per 2 s: ~30 dB down after another second, ~66 dB by 2.2 s (give or take).
    expect(20 * Math.log10(early / mid)).toBeGreaterThan(18);
    expect(20 * Math.log10(early / mid)).toBeLessThan(45);
    expect(20 * Math.log10(early / late)).toBeGreaterThan(45);
    for (let c = 0; c < 2; c++) expect(buffer.getChannelData(c).every(Number.isFinite)).toBe(true);
  });

  it('a project saved before the Engine param plays the algorithmic engine, as loud as the convolution one', async () => {
    const saved = { decay: 1.8, size: 0.5, damping: 0.15, preDelay: 0.01, mix: 0.5 };
    const old = reverbs(1, saved);
    const algo = reverbs(1, { ...saved, engine: 'algorithmic' });
    const conv = reverbs(1, { ...saved, engine: 'convolution' });
    const a = (await render(old.project, old.patternId, 1)).buffer;
    const b = (await render(algo.project, algo.patternId, 1)).buffer;
    const c = (await render(conv.project, conv.patternId, 1)).buffer;
    let diff = 0;
    for (let ch = 0; ch < 2; ch++) {
      const x = a.getChannelData(ch);
      const y = b.getChannelData(ch);
      for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs((x[i] as number) - (y[i] as number)));
    }
    expect(diff).toBe(0);
    const level = (buf: AudioBuffer) => rmsRange(buf, 0, buf.length, 0) + rmsRange(buf, 0, buf.length, 1);
    const db = 20 * Math.log10(level(b) / level(c));
    console.info(`[reverb] algorithmic vs convolution level on a drum loop at 50 % mix: ${db.toFixed(2)} dB`);
    expect(Math.abs(db)).toBeLessThan(1.5);
    // Wet only, every preset: the algorithmic engine replaces the convolution one at about its level.
    const rows: string[] = [];
    for (const preset of reverb.presets ?? []) {
      const p = { ...(preset.params as Record<string, ParamValue>), mix: 1 };
      const x = reverbs(1, { ...p, engine: 'algorithmic' });
      const y = reverbs(1, { ...p, engine: 'convolution' });
      const wet =
        20 *
        Math.log10(
          level((await render(x.project, x.patternId, 1)).buffer) /
            level((await render(y.project, y.patternId, 1)).buffer),
        );
      rows.push(`${preset.name} ${wet.toFixed(2)} dB`);
      expect(Math.abs(wet), preset.name).toBeLessThan(2.5);
    }
    console.info(`[reverb] algorithmic vs convolution, wet only: ${rows.join(', ')}`);
  }, 120_000);
});
