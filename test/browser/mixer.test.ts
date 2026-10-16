import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { MASTER, type ChannelId, type InsertId, type NoteId, type PatternId, type Project } from '@core/model/types';
import { addChannel, setChannelProp } from '@core/ops/channels';
import { setInsertProp, toggleSoloInsert } from '@core/ops/mixer';
import { addNote } from '@core/ops/notes';
import { renderOffline } from '@engine/render-offline';
import {
  defaultValues,
  defineInstrument,
  defineWorkletInstrument,
  GraphVoices,
  mtof,
  p,
  type PluginDef,
} from '@agstudio/sdk';
import processor from './impulse.worklet.ts?worker&url';
import { EFFECTS, kitProject, maxDiff, peak, resolver, rms, withInsert, type FxSpec } from '../helpers/fixtures';
import { latentEffect } from '../helpers/routing';

const SR = 48000;
const CEILING = Math.pow(10, -0.3 / 20);
const byId = (id: string) => EFFECTS.find((d) => d.id === id)!;

/** One impulse of 0.5 per note-on, frame-exact (from the worklet timing tests). */
const impulse = defineWorkletInstrument({ id: 'test.impulse', name: 'Impulse', version: 1, params: {}, processor });

/** A plain sine per note at a fixed level (a steady signal for level measurements). */
const sine = defineInstrument({
  id: 'test.sine',
  name: 'Sine',
  version: 1,
  params: { level: p.float(0, 1, 0.01) },
  create({ audioContext: ac, params }) {
    const out = new GainNode(ac);
    const voices = new GraphVoices(ac, out, { max: 4 });
    return {
      output: out,
      noteOn({ time, noteId, key }) {
        const t = Math.max(time, ac.currentTime);
        const osc = new OscillatorNode(ac, { frequency: mtof(key) });
        const vca = new GainNode(ac, { gain: params.level.value });
        osc.connect(vca);
        osc.start(t);
        voices.add(noteId, { start: t, sources: [osc], out: vca });
      },
      noteOff: ({ noteId, time }) => voices.release(noteId, time),
      allNotesOff: (time, hard) => voices.releaseAll(time, hard),
      dispose: () => {
        voices.disposeAll();
        out.disconnect();
      },
    };
  },
});

/** An effect with 288 frames of latency (what the v1 Compressor's DynamicsCompressorNode had at 48 kHz). */
const latent = latentEffect(288);

const plugins = resolver(impulse as PluginDef, sine as PluginDef, latent);

async function render(project: Project, patternId: PatternId, bars = 1) {
  return (
    await renderOffline(project, { plugins, view: { mode: 'pattern', patternId, loop: null }, bars, sampleRate: SR })
  ).buffer;
}

/** A project with one channel playing `def` (one whole-bar note, or a single note at tick 0 for impulses). */
function singleChannel(def: PluginDef, key = 69): { project: Project; patternId: PatternId; channel: ChannelId } {
  let project = createEmptyProject();
  const patternId = project.patternOrder[0] as PatternId;
  const ch = makeInstrumentChannel(def.name, makePluginInstance(def.id, def.version, defaultValues(def.params)));
  project = produce(project, (d) => {
    d.transport.bpm = 120;
    addChannel(d, ch);
    addNote(d, patternId, ch.id, { id: 'n1' as NoteId, tick: 0, length: 3840, key, velocity: 1 });
  });
  return { project, patternId, channel: ch.id };
}

const loop = () =>
  kitProject([
    { generator: 'kit/kick', steps: [0, 8] },
    { generator: 'kit/snare', steps: [4, 12] },
    { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
  ]);

function argmax(buffer: AudioBuffer): number {
  const d = buffer.getChannelData(0);
  let best = -1;
  let at = -1;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i] as number);
    if (a > best) {
      best = a;
      at = i;
    }
  }
  return at;
}

function peakNear(data: Float32Array, center: number, radius: number): { at: number; value: number } {
  let value = 0;
  let at = -1;
  for (let i = Math.max(0, center - radius); i <= Math.min(data.length - 1, center + radius); i++) {
    const a = Math.abs(data[i] as number);
    if (a > value) {
      value = a;
      at = i;
    }
  }
  return { at, value };
}

function distinct(buffer: AudioBuffer): number {
  return new Set(buffer.getChannelData(0)).size;
}

// Concurrent: every test is its own offline render (on audio threads) and shares nothing, so they overlap.
describe.concurrent('mixer inserts', () => {
  it('an insert fader at -6.02 dB renders half the peak of 0 dB', async () => {
    const { project, patternId, channels } = kitProject([{ generator: 'kit/snare', steps: [0, 8] }]);
    const quiet = produce(project, (d) => setChannelProp(d, channels[0]!, 'volume', 0.5));
    const full = await render(withInsert(quiet, channels, { volume: 1 }).project, patternId);
    const half = await render(withInsert(quiet, channels, { volume: 0.5 }).project, patternId);
    expect(peak(full)).toBeGreaterThan(0.05);
    expect(peak(full)).toBeLessThan(CEILING);
    expect(peak(half) / peak(full)).toBeCloseTo(0.5, 6);
  });

  it('a muted insert is silent', async () => {
    const { project, patternId, channels } = loop();
    const buffer = await render(withInsert(project, channels, { muted: true }).project, patternId);
    expect(peak(buffer)).toBeLessThan(1e-6);
  });

  it('solo silences the other inserts but not channels on the master', async () => {
    const { project, patternId, channels } = loop();
    const [kick, snare, hat] = channels as [ChannelId, ChannelId, ChannelId];
    const routed = withInsert(withInsert(project, [kick], { index: 1 }).project, [snare], { index: 2 }).project;
    const ins2 = routed.mixer.order[2] as InsertId;
    const soloed = produce(routed, (d) => toggleSoloInsert(d, routed.mixer.order[1] as InsertId));
    const muted = produce(routed, (d) => setInsertProp(d, ins2, 'muted', true));
    const a = await render(soloed, patternId);
    const b = await render(muted, patternId);
    expect(rms(a)).toBeGreaterThan(0.01);
    expect(maxDiff(a, b)).toBe(0);
    // The hat (on the master) is still part of the soloed mix.
    const noHat = await render(
      produce(muted, (d) => setChannelProp(d, hat, 'muted', true)),
      patternId,
    );
    expect(maxDiff(a, noHat)).toBeGreaterThan(0.01);
  });

  it('a channel routed to an unknown insert plays through the master', async () => {
    const { project, patternId, channels } = loop();
    const lost = produce(project, (d) => setChannelProp(d, channels[0]!, 'output', 'ins_missing' as InsertId));
    expect(maxDiff(await render(lost, patternId), await render(project, patternId))).toBe(0);
  });

  it('the master fader and mute apply to everything', async () => {
    const { project, patternId, channels } = kitProject([{ generator: 'kit/snare', steps: [0] }]);
    const quiet = produce(project, (d) => setChannelProp(d, channels[0]!, 'volume', 0.5));
    const full = await render(quiet, patternId);
    const half = await render(
      produce(quiet, (d) => setInsertProp(d, MASTER, 'volume', 0.5)),
      patternId,
    );
    expect(peak(half) / peak(full)).toBeCloseTo(0.5, 6);
    const off = await render(
      produce(quiet, (d) => setInsertProp(d, MASTER, 'muted', true)),
      patternId,
    );
    expect(peak(off)).toBeLessThan(1e-6);
  });
});

describe.concurrent('effect slots', () => {
  for (const def of EFFECTS) {
    it(`a disabled ${def.id} slot renders bit-exact identical to no slot`, async () => {
      const { project, patternId, channels } = loop();
      const bare = await render(withInsert(project, channels).project, patternId);
      const bypassed = await render(
        withInsert(project, channels, {
          fx: [{ def, params: def.presets?.[1]?.params as FxSpec['params'], enabled: false }],
        }).project,
        patternId,
      );
      expect(maxDiff(bare, bypassed)).toBe(0);
    });
  }

  it('slot mix 0 passes the dry signal and mix blends linearly', async () => {
    const { project, patternId, channels } = loop();
    const eq = byId('agstudio.eq');
    const boost = { lowGain: 12, midGain: 12, highGain: 12 };
    const dry = await render(withInsert(project, channels, { volume: 0.25 }).project, patternId);
    const at = (mix: number) =>
      render(withInsert(project, channels, { volume: 0.25, fx: [{ def: eq, params: boost, mix }] }).project, patternId);
    const [m0, m1, half] = await Promise.all([at(0), at(1), at(0.5)]);
    expect(maxDiff(m0, dry)).toBe(0);
    expect(maxDiff(m1, dry)).toBeGreaterThan(0.01);
    // mix 0.5 = halfway between dry and wet, sample by sample.
    let err = 0;
    for (let c = 0; c < 2; c++) {
      const [d, w, h] = [dry, m1, half].map((b) => b.getChannelData(c));
      for (let i = 0; i < h!.length; i++) err = Math.max(err, Math.abs(h![i]! - (d![i]! + w![i]!) / 2));
    }
    expect(err).toBeLessThan(1e-5);
  });

  it('keeps dry and wet aligned for effects with latency', async () => {
    const { project, patternId, channel } = singleChannel(impulse as PluginDef);
    const bare = await render(withInsert(project, [channel]).project, patternId);
    const wet = await render(withInsert(project, [channel], { fx: [{ def: latent }] }).project, patternId);
    const half = await render(withInsert(project, [channel], { fx: [{ def: latent, mix: 0.5 }] }).project, patternId);
    const i0 = argmax(bare);
    const latency = 288;
    expect(argmax(wet) - i0).toBe(latency);
    expect(argmax(half) - i0).toBe(latency);
    // Nothing comes through undelayed: the slot's dry path is delayed to match.
    expect(Math.abs(half.getChannelData(0)[i0]!)).toBeLessThan(1e-4);
  });
});

describe.concurrent('built-in effects', () => {
  const builtins = import.meta.glob<{ default: PluginDef }>('/src/plugins/builtin/*/index.ts', { eager: true });
  const ids = [
    'agstudio.eq',
    'agstudio.filter',
    'agstudio.delay',
    'agstudio.reverb',
    'agstudio.compressor',
    'agstudio.distortion',
    'agstudio.ducker',
    'agstudio.gate',
  ];

  it('are all discovered as effects with presets', () => {
    const defs = Object.values(builtins).map((m) => m.default);
    for (const id of ids) {
      const def = defs.find((d) => d.id === id);
      expect(def?.kind).toBe('effect');
      expect(def?.presets?.length).toBeGreaterThanOrEqual(3);
    }
  });

  for (const def of EFFECTS) {
    it(`${def.id} renders finite, non-silent output deterministically`, async () => {
      const { project, patternId, channels } = loop();
      const params = (def.presets?.[1] ?? def.presets?.[0])?.params as FxSpec['params'];
      const fxProject = withInsert(project, channels, { fx: [{ def, params }] }).project;
      const dry = await render(withInsert(project, channels).project, patternId);
      const a = await render(fxProject, patternId);
      const b = await render(fxProject, patternId);
      for (let c = 0; c < 2; c++)
        for (const x of a.getChannelData(c)) if (!Number.isFinite(x)) throw new Error('not finite');
      expect(peak(a)).toBeGreaterThan(0.01);
      expect(peak(a)).toBeLessThanOrEqual(CEILING + 1e-6);
      expect(maxDiff(a, dry)).toBeGreaterThan(1e-3);
      expect(maxDiff(a, b)).toBeLessThan(1e-6);
    });
  }

  it('the bitcrusher reduces the number of distinct sample values', async () => {
    const { project, patternId, channels } = kitProject([{ generator: 'kit/snare', steps: [0, 4, 8, 12] }]);
    const quiet = produce(project, (d) => setChannelProp(d, channels[0]!, 'volume', 0.5));
    const crusher = byId('user.example-bitcrusher');
    const clean = await render(withInsert(quiet, channels).project, patternId);
    const crushed = await render(
      withInsert(quiet, channels, { fx: [{ def: crusher, params: { bits: 4, downsample: 1, mix: 1 } }] }).project,
      patternId,
    );
    expect(distinct(clean)).toBeGreaterThan(1000);
    expect(distinct(crushed)).toBeLessThanOrEqual(2 ** 4 + 1);
    expect(peak(crushed)).toBeGreaterThan(0.05);
  });

  it('the delay repeats exactly on the tempo-synced time, straight and ping-pong', async () => {
    const { project, patternId, channel } = singleChannel(impulse as PluginDef);
    const delay = byId('agstudio.delay');
    const i0 = argmax(await render(withInsert(project, [channel]).project, patternId));
    const beat = SR / 2; // a quarter note at 120 BPM
    for (const pingPong of [false, true]) {
      const params = { time: '1/4', feedback: 0.6, mix: 1, pingPong, lowCut: 20, highCut: 20000 };
      const out = await render(withInsert(project, [channel], { fx: [{ def: delay, params }] }).project, patternId);
      for (let n = 1; n <= 4; n++) {
        // Ping-pong starts on the left and alternates; straight echoes are on both sides.
        const side = pingPong ? (n % 2 === 1 ? 0 : 1) : 0;
        const echo = peakNear(out.getChannelData(side), i0 + n * beat, 2000);
        expect(Math.abs(echo.at - (i0 + n * beat))).toBeLessThanOrEqual(2);
        expect(echo.value).toBeGreaterThan(0.01 * 0.6 ** n);
        if (pingPong) expect(peakNear(out.getChannelData(1 - side), i0 + n * beat, 100).value).toBeLessThan(1e-4);
      }
    }
  });

  it('the compressor leaves quiet signals at unity and adds no latency', async () => {
    const { project, patternId, channel } = singleChannel(sine as PluginDef);
    const compressor = byId('agstudio.compressor');
    const bare = await render(withInsert(project, [channel]).project, patternId);
    const comp = await render(
      withInsert(project, [channel], { fx: [{ def: compressor, params: { threshold: -24, knee: 6, ratio: 4 } }] })
        .project,
      patternId,
    );
    expect(maxDiff(comp, bare)).toBe(0);
    const pulse = singleChannel(impulse as PluginDef);
    const dry = await render(withInsert(pulse.project, [pulse.channel]).project, pulse.patternId);
    const squashed = await render(
      withInsert(pulse.project, [pulse.channel], {
        fx: [{ def: compressor, params: { threshold: -40, ratio: 20, knee: 0, attack: 0.5 } }],
      }).project,
      pulse.patternId,
    );
    expect(argmax(squashed)).toBe(argmax(dry));
    const loud = await render(
      withInsert(
        produce(project, (d) => setChannelProp(d, channel, 'volume', 1.25)),
        [channel],
        {
          volume: MAX_INSERT_VOLUME,
          fx: [{ def: compressor, params: { threshold: -60, knee: 0, ratio: 20 } }],
        },
      ).project,
      patternId,
    );
    // No look-ahead: the onset passes until the attack catches it, so compare levels, not peaks.
    expect(rms(loud)).toBeLessThan(rms(bare) / 2);
  });

  it('the distortion reports the wave shaper’s real latency', async () => {
    const { project, patternId, channel } = singleChannel(impulse as PluginDef);
    const distortion = byId('agstudio.distortion');
    const clean = { drive: 0, curve: 'hard', tone: 20000, mix: 1, output: 0 };
    const bare = await render(withInsert(project, [channel]).project, patternId);
    const wet = await render(
      withInsert(project, [channel], { fx: [{ def: distortion, params: clean }] }).project,
      patternId,
    );
    const blend = await render(
      withInsert(project, [channel], { fx: [{ def: distortion, params: { ...clean, mix: 0.5 } }] }).project,
      patternId,
    );
    const i0 = argmax(bare);
    expect(Math.abs(argmax(wet) - i0 - 192)).toBeLessThanOrEqual(2);
    expect(Math.abs(argmax(blend) - i0 - 192)).toBeLessThanOrEqual(2);
    expect(Math.abs(blend.getChannelData(0)[i0]!)).toBeLessThan(1e-3);
  });
});

describe.concurrent('master safety limiter', () => {
  it('holds the -0.3 dBFS ceiling with an insert driven hot', async () => {
    const { project, patternId, channels } = loop();
    const hot = produce(
      withInsert(project, channels, {
        volume: MAX_INSERT_VOLUME,
        fx: [
          { def: byId('agstudio.eq'), params: { lowGain: 18, midGain: 18, highGain: 18 } },
          { def: byId('agstudio.distortion'), params: { drive: 36, curve: 'hard', output: 12 } },
        ],
      }).project,
      (d) => setInsertProp(d, MASTER, 'volume', MAX_INSERT_VOLUME),
    );
    const buffer = await render(hot, patternId);
    expect(peak(buffer)).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peak(buffer)).toBeGreaterThan(0.9 * CEILING);
  });
});
