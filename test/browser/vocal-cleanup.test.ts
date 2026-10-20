/**
 * Vocal cleanup in the real engine (offline renders: what export uses): a clip with a cleanup plays its cleaned render, not the
 * channel's own sample, the recording without one, and falls back to the recording when the render is missing; the Denoise
 * effect (a real AudioWorklet) turns a learned noise down, reports its latency to the mixer and renders the same twice.
 * The cleanup itself is checked in core/audio/cleanup, the renderer in app/actions.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { testHost, runEffect } from '@agstudio/sdk/testing';
import { cleanupSignature } from '@core/audio/cleanup-edit';
import { renderCleanup } from '@core/audio/cleanup/render';
import { pinkNoise, rms, syntheticPhrase, toDb } from '@core/audio/cleanup/test-signals';
import { createServices, type Services } from '@app/services';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import type { AudioClip, InsertId, Project, VocalCleanup } from '@core/model/types';
import { addFxSlot, addInsert } from '@core/ops/mixer';
import { setChannelProp } from '@core/ops/channels';
import { renderOffline } from '@engine/render-offline';
import { DenoiseKernel, type ProfileMessage } from '../../src/plugins/builtin/denoise/kernel';
import { denoiseParams } from '../../src/plugins/builtin/denoise/params';
import { audioClipProject, TestSamples } from '../helpers/audio';

const SR = 48000;
const BARS = 3;
const FX = 'ins_fx' as InsertId;

const services: Services[] = [];
afterAll(async () => {
  for (const s of services) await s.engine.dispose();
});

async function render(s: Services, samples: TestSamples, project: Project) {
  const r = await renderOffline(project, {
    plugins: s.plugins,
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: BARS,
    sampleRate: SR,
    tail: 0,
    limiter: false,
  });
  const start = Math.round((r.preRoll + r.latency) * SR);
  return { left: r.buffer.getChannelData(0).subarray(start), right: r.buffer.getChannelData(1).subarray(start), latency: r.latency };
}

/** The level in dB of the room-noise stretch at the start of the phrase (0.1 to 0.7 s). */
const quietDb = (x: Float32Array) => toDb(rms(x, Math.round(0.1 * SR), Math.round(0.7 * SR)));

describe('a cleaned-up clip in the engine', () => {
  it('plays the cleaned render (12 dB less room noise), the recording without it, and the recording when the render is missing', async () => {
    const s = createServices();
    services.push(s);
    const phrase = syntheticPhrase({ seconds: 6, noiseDb: -40, seed: 4 });
    const settings: VocalCleanup = { noise: { amountDb: 12, sensitivity: 0.5, from: 0.1, to: 0.7 } };
    const cleaned = renderCleanup({ channels: [phrase.mix], sampleRate: SR, settings }).channels[0] as Float32Array;
    const samples = new TestSamples();
    const original = samples.add([phrase.mix, phrase.mix.slice()], SR, 'vocal');
    const renderedRef = samples.add([cleaned, cleaned.slice()], SR, 'vocal (cleaned up)');
    const { project, clipIds } = audioClipProject(original, [{ start: 0, length: BARS * 3840 }]);
    const clipId = clipIds[0]!;
    const withCleanup = (rendered: boolean): Project =>
      produce(project, (d) => {
        if (rendered) d.samples[renderedRef.id] = renderedRef as never;
        (d.playlist.clips[clipId] as AudioClip).cleanup = {
          ...settings,
          ...(rendered ? { renderedSampleId: renderedRef.id, renderedFor: cleanupSignature(settings) } : {}),
        } as never;
      });

    const plain = quietDb((await render(s, samples, withCleanup(false))).left);
    const clean = quietDb((await render(s, samples, withCleanup(true))).left);
    expect(plain - clean).toBeGreaterThan(11.5);
    expect(plain - clean).toBeLessThan(12.5);
    // The render's sample is not in the project (a damaged file): the clip plays the recording, not silence.
    const missing = produce(withCleanup(true), (d) => void delete d.samples[renderedRef.id]);
    expect(Math.abs(quietDb((await render(s, samples, missing)).left) - plain)).toBeLessThan(0.1);
    console.log(`cleaned clip in the engine: room noise ${plain.toFixed(1)} dBFS as recorded, ${clean.toFixed(1)} dBFS cleaned`);
  }, 120_000);
});

describe('the Denoise effect in the engine', () => {
  /** A project with white-ish room noise on a track routed through Denoise, with a learned noise in its state. */
  function noisyProject(s: Services, amount: number) {
    const noise = pinkNoise(SR * 6, -34, 9);
    const samples = new TestSamples();
    const ref = samples.add([noise, noise.slice()], SR, 'room');
    const { project, channelId } = audioClipProject(ref, [{ start: 0, length: BARS * 3840 }]);
    // Learn the noise as a user does (Learn on while only the room is heard, then off), here through the kernel itself.
    const host = testHost(SR, 1);
    const kernel = new DenoiseKernel(host);
    runEffect(kernel, denoiseParams, (i) => noise[i % noise.length] as number, SR, { params: { learn: 1 } });
    runEffect(kernel, denoiseParams, () => 0, 1024, { params: { learn: 0 } });
    const message = host.posted.find((m): m is ProfileMessage => (m as { type?: string }).type === 'profile');
    expect(message).toBeDefined();
    const state = { profile: Array.from(message!.bins), frames: message!.frames };
    const withEffect = produce(project, (d) => {
      addInsert(d, makeInsert(FX, 'Room'));
      setChannelProp(d, channelId as never, 'output', FX);
      addFxSlot(d, FX, makePluginInstance('agstudio.denoise', 1, { amount, sensitivity: 0.5 }, { state }));
    });
    return { samples, withEffect, plain: project };
  }

  it('turns a learned noise down by about the amount, and an export of the same project is bit-identical', async () => {
    const s = createServices();
    services.push(s);
    const { samples, withEffect, plain } = noisyProject(s, 12);
    const dry = await render(s, samples, plain);
    const first = await render(s, samples, withEffect);
    const second = await render(s, samples, withEffect);
    const from = Math.round(1 * SR);
    const to = Math.round(4 * SR);
    const down = toDb(rms(dry.left, from, to) / rms(first.left, from, to));
    expect(down).toBeGreaterThan(10);
    expect(down).toBeLessThan(13.5);
    expect(first.left.length).toBe(second.left.length);
    expect(first.left.every((v, i) => v === second.left[i] && first.right[i] === second.right[i])).toBe(true);
    console.log(`Denoise in the engine: learned pink noise ${down.toFixed(1)} dB down at 12 dB`);
  }, 120_000);

  it('reports its one-frame latency to the mixer, which compensates it: the track stays in time with a track that has none', async () => {
    const s = createServices();
    services.push(s);
    const { samples, withEffect, plain } = noisyProject(s, 0);
    const dry = await render(s, samples, plain);
    const wet = await render(s, samples, withEffect);
    // Amount 0 is a pure delay of the plugin's latency: with the mixer's compensation the two renders line up (the offline
    // render starts after the compensation), so the noise matches sample for sample (within the 24-bit chain of one kernel pass).
    let worst = 0;
    for (let i = Math.round(0.5 * SR); i < Math.round(3 * SR); i += 31) worst = Math.max(worst, Math.abs((dry.left[i] as number) - (wet.left[i] as number)));
    expect(worst).toBeLessThan(1e-3);
    expect(wet.latency).toBeGreaterThanOrEqual(1024 / SR - 1e-9);
  }, 120_000);
});
