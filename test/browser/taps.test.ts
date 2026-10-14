import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makePluginInstance } from '@core/model/defaults';
import { MASTER, type PluginOwner } from '@core/model/types';
import { addFxSlot, removeFxSlot } from '@core/ops/mixer';
import { Engine } from '@engine/engine';
import { TapImpl } from '@engine/tap';
import { TapRegistry } from '@app/taps';
import { defineWorkletEffect, type AudioTap, type PluginDef } from '@agstudio/sdk';
import processor from './transport.worklet.ts?worker&url';
import { resolver } from '../helpers/fixtures';

const SR = 48000;

describe('visualization taps', () => {
  it('reads a full-scale sine at 0 dBFS in its bin, its waveform and published readings', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
    // A sine centred on bin 85 of a 4096-point FFT.
    const freq = (85 * SR) / 4096;
    const osc = new OscillatorNode(ctx, { frequency: freq });
    const tap = new TapImpl(ctx, osc, { fftSize: 4096, smoothing: 0 });
    osc.start();
    const bins = new Float32Array(2048);
    const wave = new Float32Array(1024);
    let peakBin = -1;
    let peakDb = -Infinity;
    let wavePeak = 0;
    // The per-channel analysers start listening the first time the editor asks for a waveform.
    expect(tap.waveform(wave, 0)).toBe(true);
    expect(wave.every((v) => v === 0)).toBe(true);
    void ctx.suspend(0.5).then(() => {
      expect(tap.spectrum(bins)).toBe(true);
      bins.forEach((v, i) => {
        if (v > peakDb) [peakDb, peakBin] = [v, i];
      });
      expect(tap.waveform(wave, 0)).toBe(true);
      wavePeak = Math.max(...Array.from(wave, Math.abs));
      void ctx.resume();
    });
    await ctx.startRendering();
    expect(peakBin).toBe(85);
    expect(Math.abs(peakDb)).toBeLessThan(0.5);
    expect(wavePeak).toBeGreaterThan(0.99);
    tap.publish({ gr: -3.5 });
    expect(tap.reading('gr')).toBe(-3.5);
    expect(tap.reading('nope')).toBeUndefined();
    tap.dispose();
    expect(tap.active).toBe(false);
    expect(tap.spectrum(bins)).toBe(false);
  });

  it('the engine reports each instance’s tap per owner, and the registry hands out a stable view', async () => {
    const tapped = defineWorkletEffect({
      id: 'test.beat-out',
      name: 'Beat out',
      version: 1,
      params: {},
      processor,
      tap: true,
    }) as PluginDef;
    const registry = new TapRegistry();
    const reports: { owner: PluginOwner; live: boolean; tap: AudioTap }[] = [];
    const engine = Engine.realtime({
      plugins: resolver(tapped),
      onPluginTap: (owner, tap, live) => {
        reports.push({ owner, live, tap });
        registry.report(owner, tap, live);
      },
    });
    let slotId = '';
    const base = createEmptyProject();
    const withFx = produce(base, (d) => {
      slotId = addFxSlot(d, MASTER, makePluginInstance(tapped.id, 1, {}))!;
    });
    engine.applyDocChange({ next: withFx, prev: withFx, patches: null, origin: 'load' });
    await engine.ready();
    const owner = { kind: 'fx', insertId: MASTER, slotId } as PluginOwner;
    const view = registry.view(owner);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ owner, live: true });
    expect(view.active).toBe(true);
    expect(view.sampleRate).toBe(engine.sampleRate);
    expect(registry.view(owner)).toBe(view);
    // Removing the effect takes its tap away; the view stays and goes inactive.
    const without = produce(withFx, (d) => {
      removeFxSlot(d, MASTER, slotId as never);
    });
    engine.applyDocChange({ next: without, prev: withFx, patches: [], origin: 'edit' });
    await new Promise((r) => setTimeout(r, 150));
    expect(reports.at(-1)).toMatchObject({ owner, live: false });
    expect(view.active).toBe(false);
    expect(view.spectrum(new Float32Array(16))).toBe(false);
    await engine.dispose();
  });
});
