/**
 * Offline renders repeat bit for bit. Exports, freeze, loudness measurement and auto-level all assume it.
 *
 * The thing that broke it: Chrome adds the inputs of a node that has three or more in an order that changes from run
 * to run, and float addition is not associative. Overlapping drum hits (several voices into one Sampler), several
 * channels into one insert, several inserts into the master and the oscillators of a synth voice all do that. The
 * engine and the SDK add such inputs through `OrderedMix` (src/sdk/ordered-mix.ts), a ladder of two-input stages.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { sha256Hex } from '@core/io/hash';
import type { ChannelId, Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { SampleCache } from '@engine/samples';
import { OrderedMix, type PluginDef } from '@agstudio/sdk';
import threeOsc from '../../src/plugins/builtin/three-osc';
import { kitProject, maxDiff, resolver, withInsert } from '../helpers/fixtures';
import { instrumentProject } from '../helpers/instruments';

const SR = 48000;
const DEFAULT_CHUNK = 128 * 256;
const SMALL_CHUNK = 128 * 37;

/** A hash of everything a render produced (both channels, every frame). */
async function hashOf(buffer: AudioBuffer): Promise<string> {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(new Uint8Array(left.buffer, left.byteOffset, left.byteLength), 0);
  bytes.set(new Uint8Array(right.buffer, right.byteOffset, right.byteLength), left.byteLength);
  return sha256Hex(bytes);
}

/**
 * A drum loop with overlapping tails: kick, snare, closed and open hats (the open hat rings over its neighbours) and
 * a long, pitched-down trap kick as the 808. The sounds sit on three inserts that all feed the master.
 */
function drumLoop(): { project: Project; patternId: ReturnType<typeof kitProject>['patternId'] } {
  const tracks = [
    { generator: 'kit/kick', steps: [0, 4, 8, 12] },
    { generator: 'kit/snare', steps: [4, 12] },
    { generator: 'kit/hat-closed', steps: [0, 2, 4, 6, 8, 10, 12, 14] },
    { generator: 'kit/hat-open', steps: [1, 3, 5, 7, 9, 11, 13, 15] },
    { generator: 'kit/trap/kick', steps: [0, 6, 10] },
  ];
  const { project, patternId, channels } = kitProject(tracks);
  const [kick, snare, closedHat, openHat, bass] = channels as [ChannelId, ChannelId, ChannelId, ChannelId, ChannelId];
  let routed = withInsert(project, [kick, bass], { index: 1 }).project;
  routed = withInsert(routed, [snare], { index: 2 }).project;
  routed = withInsert(routed, [closedHat, openHat], { index: 3 }).project;
  const tuned = produce(routed, (d) => {
    const channel = d.channels[bass];
    if (channel?.kind === 'instrument') channel.plugin.params.tune = -12;
  });
  return { project: tuned, patternId };
}

describe('offline renders repeat bit for bit', () => {
  it('a drum loop renders identically cold and warm, at each of two chunk sizes', async () => {
    const { project, patternId } = drumLoop();
    const render = (chunk: number, sampleCache?: SampleCache) =>
      renderOffline(project, {
        plugins: resolver(),
        view: { mode: 'pattern', patternId, loop: null },
        bars: 2,
        sampleRate: SR,
        chunk,
        ...(sampleCache ? { sampleCache } : {}),
      }).then((result) => result.buffer);
    const firstOfAll: AudioBuffer[] = [];
    for (const chunk of [DEFAULT_CHUNK, SMALL_CHUNK]) {
      // Cold: the engine makes its own sample cache, so the kit sounds are generated during the render.
      const cold = await render(chunk);
      const shared = new SampleCache();
      const coldShared = await render(chunk, shared);
      // Warm: the sounds are already in the cache.
      const warm = await render(chunk, shared);
      const reference = await hashOf(cold);
      expect(await hashOf(await render(chunk)), `cold twice, chunk ${chunk}`).toBe(reference);
      expect(await hashOf(coldShared), `cold, shared cache, chunk ${chunk}`).toBe(reference);
      expect(await hashOf(warm), `warm, chunk ${chunk}`).toBe(reference);
      firstOfAll.push(cold);
    }
    // Another chunk size schedules the voices in another order, so voices reuse mix slots differently and the sums can
    // differ by a last bit. They still sound the same.
    expect(maxDiff(firstOfAll[0]!, firstOfAll[1]!)).toBeLessThan(1e-6);
  });

  it('a chord on the 3xOsc renders identically (three oscillators add up in each voice)', async () => {
    const chord = [60, 64, 67, 71].map((key) => ({ at: 0, len: 1.5, key }));
    const params = { osc2Level: 0.8, osc3Level: 0.6 };
    const { project, patternId } = instrumentProject(threeOsc, chord, { params });
    const render = async () =>
      hashOf(
        (
          await renderOffline(project, {
            plugins: resolver(threeOsc as PluginDef),
            view: { mode: 'pattern', patternId, loop: null },
            bars: 1,
            sampleRate: SR,
          })
        ).buffer,
      );
    const reference = await render();
    for (let i = 0; i < 4; i++) expect(await render()).toBe(reference);
  });
});

describe('OrderedMix', () => {
  /** Eight different noise sources, each starting at its own moment, through gains into one node. */
  async function renderMix(options: { ordered: boolean; churn: boolean }): Promise<string> {
    const ctx = new OfflineAudioContext(2, SR / 2, SR);
    const sink = new GainNode(ctx);
    sink.connect(ctx.destination);
    const mix = new OrderedMix(ctx, sink, { ordered: options.ordered });
    let seed = 7;
    const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let voice = 0; voice < 8; voice++) {
      const buffer = new AudioBuffer({ length: SR / 2, sampleRate: SR, numberOfChannels: 1 });
      buffer.getChannelData(0).forEach((_, i, data) => (data[i] = noise() * 0.3));
      const source = new AudioBufferSourceNode(ctx, { buffer });
      const voiceGain = new GainNode(ctx, { gain: 0.9 });
      source.connect(voiceGain);
      const detach = mix.attach(voiceGain);
      source.start(voice * 0.01);
      // A voice that leaves early frees its place; the next one takes it.
      if (options.churn && voice % 3 === 1) {
        source.stop(0.005);
        detach();
      }
    }
    return hashOf(await ctx.startRendering());
  }

  it('adds eight sources in the same order every time, also when voices come and go', async () => {
    for (const churn of [false, true]) {
      const reference = await renderMix({ ordered: true, churn });
      for (let i = 0; i < 8; i++) expect(await renderMix({ ordered: true, churn }), `churn ${churn}`).toBe(reference);
    }
  });

  it('gives the same sum as connecting the sources directly (up to rounding)', async () => {
    const sum = async (ordered: boolean) => {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const mix = new OrderedMix(ctx, ctx.destination, { ordered });
      for (let i = 1; i <= 5; i++) {
        const constant = new ConstantSourceNode(ctx, { offset: i });
        mix.attach(constant);
        constant.start();
      }
      return (await ctx.startRendering()).getChannelData(0)[64]!;
    };
    expect(await sum(true)).toBe(15);
    expect(await sum(false)).toBe(15);
  });
});
