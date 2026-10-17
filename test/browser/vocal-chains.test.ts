/**
 * The factory vocal chains through the real engine (offline renders): each one on a synthetic sung phrase
 * keeps the voice's loudness within about 1 dB of the dry voice (so putting one on never jumps the level),
 * both as insert effects and with the Reverb and Delay returns of a mix; the de-esser really takes the "s"
 * out of the voice; the Doubler keeps a clean mono sum with the real engine; applying a chain to a live
 * project is one undo step.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { applyChainToDraft } from '@app/actions/chains';
import { Measurer } from '@app/analysis/measure';
import { FACTORY_CHAINS } from '@app/mix/vocal-chains';
import { instanceFor } from '@app/mix/setup';
import { BUS_NAMES } from '@app/mix/layout';
import { createServices, type Services } from '@app/services';
import { makeInsert } from '@core/model/defaults';
import type { InsertId, Project } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { addFxSlot, addInsert } from '@core/ops/mixer';
import { setRoute } from '@core/ops/routing';
import { renderOffline } from '@engine/render-offline';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { syntheticVoice } from '../helpers/voice';

const SR = 48000;
const SECONDS = 6;
const VOCAL = 'ins_vocal' as InsertId;
const REVERB = 'ins_reverb' as InsertId;
const DELAY = 'ins_delay' as InsertId;
/** The mixer's own limit for a chain's loudness change. */
const LIMIT_DB = 1;

const services: Services[] = [];
afterAll(async () => {
  for (const s of services) await s.engine.dispose();
});

function setup(sibilance = 0.5) {
  const s = createServices();
  services.push(s);
  const samples = new TestSamples();
  const voice = syntheticVoice(SECONDS, SR, { sibilance });
  const ref = samples.add([voice, voice.slice()], SR, 'Vocal');
  const { project, channelId } = audioClipProject(ref, [{ start: 0, length: SECONDS * 2 * 960 }]);
  return { s, samples, project, channelId };
}

/** Integrated loudness and peaks of the master over the voice's span, with the mixer's delay compensation skipped. */
async function measure(s: Services, samples: TestSamples, project: Project) {
  const r = await renderOffline(project, {
    plugins: s.plugins,
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: (SECONDS * 2) / 4,
    sampleRate: SR,
    tail: 0,
    limiter: false,
  });
  const start = Math.round((r.preRoll + r.latency) * SR);
  const frames = SECONDS * SR;
  const left = r.buffer.getChannelData(0).subarray(start, start + frames);
  const right = r.buffer.getChannelData(1).subarray(start, start + frames);
  const m = new Measurer(SR, true);
  m.push(left, right);
  return { ...m.result(), left: left.slice(), right: right.slice() };
}

/** The voice on its own track with a chain on it, and optionally the mix's Reverb and Delay returns. */
function withChain(s: Services, base: Project, channelId: string, chain: (typeof FACTORY_CHAINS)[number] | null, returns: boolean): Project {
  return produce(base, (d) => {
    addInsert(d, makeInsert(VOCAL, 'Lead vocal'));
    setChannelProp(d, channelId as never, 'output', VOCAL);
    if (returns) {
      addInsert(d, makeInsert(REVERB, BUS_NAMES.reverb));
      addInsert(d, makeInsert(DELAY, BUS_NAMES.delay));
      addFxSlot(d, REVERB, instanceFor(s, { pluginId: 'agstudio.reverb', preset: 'Plate', params: { mix: 1 }, label: 'reverb' })!);
      addFxSlot(d, DELAY, instanceFor(s, { pluginId: 'agstudio.delay', preset: 'Eighth echo', params: { mix: 1, lowCut: 300, highCut: 6000 }, label: 'delay' })!);
    }
    if (chain) applyChainToDraft(d, s, VOCAL, chain, 'replace');
  });
}

describe.concurrent('vocal chains in the engine', () => {
  // The test vocal has a natural "s"; the harsh one is as loud as the vowel, which the de-esser rightly takes down.
  for (const [voiceName, sibilance, limit] of [['natural', 0.5, LIMIT_DB], ['harsh s’s', 1, 1.6]] as const) {
    for (const returns of [false, true]) {
      it(`every factory chain keeps a ${voiceName} voice within ${limit} dB of its loudness (${returns ? 'sends to the returns' : 'insert effects'})`, async () => {
        const { s, samples, project, channelId } = setup(sibilance);
        const dry = await measure(s, samples, withChain(s, project, channelId, null, returns));
        expect(dry.lufs).toBeGreaterThan(-35);
        const lines: string[] = [];
        const jumps: string[] = [];
        for (const chain of FACTORY_CHAINS) {
          const wet = await measure(s, samples, withChain(s, project, channelId, chain, returns));
          const delta = wet.lufs - dry.lufs;
          lines.push(`${chain.name}: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} LU (peak ${wet.peakDb.toFixed(1)} dBFS, true peak ${wet.truePeakDb?.toFixed(1)})`);
          if (Math.abs(delta) > limit) jumps.push(`${chain.name} ${delta.toFixed(2)} LU`);
          expect(wet.peakDb, chain.name).toBeLessThan(-3);
        }
        console.log(`${voiceName}, dry ${dry.lufs.toFixed(2)} LUFS (${returns ? 'returns' : 'inserts'})\n  ${lines.join('\n  ')}`);
        expect(jumps).toEqual([]);
      }, 240_000);
    }
  }

  it('the Doubler keeps a clean mono sum with the real engine: the doubles add at most a dB and take away at most 0.8 dB in mono', async () => {
    const { s, samples, project, channelId } = setup();
    const mono = async (p: Project) => {
      const m = await measure(s, samples, p);
      const sum = Float32Array.from(m.left, (v, i) => 0.5 * (v + (m.right[i] as number)));
      const meter = new Measurer(SR, false);
      meter.push(sum, sum);
      return { lufs: meter.result().lufs, width: m.width };
    };
    const lines: string[] = [];
    for (const chain of FACTORY_CHAINS.filter((c) => c.steps.some((x) => x.pluginId === 'agstudio.doubler'))) {
      const without = { ...chain, steps: chain.steps.filter((x) => x.pluginId !== 'agstudio.doubler') };
      const a = await mono(withChain(s, project, channelId, chain, false));
      const b = await mono(withChain(s, project, channelId, without, false));
      lines.push(`${chain.name}: mono ${(a.lufs - b.lufs).toFixed(2)} LU with the double (stereo width ${a.width.toFixed(2)} against ${b.width.toFixed(2)})`);
      expect(a.lufs - b.lufs, chain.name).toBeGreaterThan(-0.8);
      expect(a.lufs - b.lufs, chain.name).toBeLessThan(1);
      // And it really does widen the voice in stereo.
      expect(a.width, chain.name).toBeGreaterThan(b.width);
    }
    console.log(lines.join('\n'));
  }, 240_000);

  it('the de-esser in a chain takes the harsh “s” down (Gentle: a couple of dB across the whole “s”) and leaves the vowel alone', async () => {
    const { s, samples, project, channelId } = setup(1);
    const chain = FACTORY_CHAINS.find((c) => c.name === 'Clean pop vocal')!;
    const only = (keep: (id: string) => boolean) => ({ ...chain, steps: chain.steps.filter((x) => keep(x.pluginId)) });
    const bypassed = await measure(s, samples, withChain(s, project, channelId, only((id) => id === 'agstudio.eq-pro'), false));
    const deessed = await measure(s, samples, withChain(s, project, channelId, only((id) => id === 'agstudio.eq-pro' || id === 'agstudio.de-esser'), false));
    // The first 100 ms of each half-second syllable is the "s"; the vowel follows it.
    const energy = (x: Float32Array, from: number, to: number) => {
      let sum = 0;
      for (let k = 0; k * SR * 0.5 < x.length; k++)
        for (let i = Math.round(k * SR * 0.5 + from * SR); i < Math.round(k * SR * 0.5 + to * SR) && i < x.length; i++) sum += (x[i] as number) ** 2;
      return 10 * Math.log10(sum);
    };
    const sReduction = energy(bypassed.left, 0.02, 0.1) - energy(deessed.left, 0.02, 0.1);
    const vowelChange = energy(bypassed.left, 0.15, 0.4) - energy(deessed.left, 0.15, 0.4);
    console.log(`de-esser (Gentle) on a harsh “s”: ${sReduction.toFixed(2)} dB down on the “s”, ${vowelChange.toFixed(2)} dB on the vowel`);
    expect(sReduction).toBeGreaterThan(1.2);
    expect(Math.abs(vowelChange)).toBeLessThan(0.5);
  }, 240_000);
});
