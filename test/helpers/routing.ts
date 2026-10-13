import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { ChannelId, InsertId, NoteId, PatternId, Project, SlotId } from '@core/model/types';
import { addChannel, setChannelProp } from '@core/ops/channels';
import { addFxSlot } from '@core/ops/mixer';
import { addNote } from '@core/ops/notes';
import type { PluginResolver } from '@engine/api';
import { Engine } from '@engine/engine';
import {
  defaultValues,
  defineEffect,
  defineInstrument,
  defineWorkletInstrument,
  GraphVoices,
  mtof,
  p,
  type ParamValue,
  type PluginDef,
} from '@agstudio/sdk';
import processor from '../browser/impulse.worklet.ts?worker&url';

export const SR = 48000;

/** One impulse of 0.5 per note-on, frame-exact. */
export const impulse = defineWorkletInstrument({
  id: 'test.impulse',
  name: 'Impulse',
  version: 1,
  params: {},
  processor,
}) as PluginDef;

/** A plain sine per note at a fixed level (a steady signal for level measurements). */
export const sine = defineInstrument({
  id: 'test.sine',
  name: 'Sine',
  version: 1,
  params: { level: p.float(0, 1, 0.05) },
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
}) as PluginDef;

/** A graph effect that delays by exactly `frames` frames and reports it as its latency. */
export function latentEffect(frames: number): PluginDef {
  return defineEffect({
    id: `test.latent-${frames}`,
    name: `Latent ${frames}`,
    version: 1,
    params: {},
    create({ audioContext: ac }) {
      const delay = new DelayNode(ac, { maxDelayTime: 1, delayTime: frames / ac.sampleRate });
      return { input: delay, output: delay, latency: frames / ac.sampleRate, dispose: () => delay.disconnect() };
    },
  }) as PluginDef;
}

/** A sidechain effect whose output is its key: what reaches `host.sidechain`. */
export const keyListener = defineEffect({
  id: 'test.key-listener',
  name: 'Key listener',
  version: 1,
  params: {},
  sidechain: true,
  create({ audioContext: ac, sidechain }) {
    const input = new GainNode(ac);
    const out = new GainNode(ac);
    sidechain?.connect(out);
    return {
      input,
      output: out,
      dispose: () => {
        input.disconnect();
        out.disconnect();
      },
    };
  },
}) as PluginDef;

/** A sidechain effect that passes its input and counts creations and disposals. */
export function countingSidechain() {
  const stats = { created: 0, disposed: 0, keyed: 0 };
  const def = defineEffect({
    id: 'test.count-sc',
    name: 'Count SC',
    version: 1,
    params: {},
    sidechain: true,
    create({ audioContext: ac, sidechain }) {
      stats.created++;
      if (sidechain) stats.keyed++;
      const g = new GainNode(ac);
      return {
        input: g,
        output: g,
        dispose() {
          stats.disposed++;
          g.disconnect();
        },
      };
    },
  }) as PluginDef;
  return { def, stats };
}

export interface ChannelSpec {
  def: PluginDef;
  /** Notes as [tick, length, key]. */
  notes: [number, number, number][];
  /** Mixer insert index (0 = master). */
  insert: number;
  volume?: number;
}

/** A 120 BPM project with one channel per spec, each routed to its insert. */
export function channelsProject(specs: ChannelSpec[]): {
  project: Project;
  patternId: PatternId;
  channels: ChannelId[];
  ins: InsertId[];
} {
  let project = createEmptyProject();
  const patternId = project.patternOrder[0] as PatternId;
  const ins = project.mixer.order;
  const channels: ChannelId[] = [];
  project = produce(project, (d) => {
    d.transport.bpm = 120;
    specs.forEach((s, ci) => {
      const ch = makeInstrumentChannel(
        s.def.name,
        makePluginInstance(s.def.id, s.def.version, defaultValues(s.def.params)),
      );
      addChannel(d, ch);
      channels.push(ch.id);
      setChannelProp(d, ch.id, 'output', ins[s.insert] as InsertId);
      if (s.volume !== undefined) setChannelProp(d, ch.id, 'volume', s.volume);
      s.notes.forEach(([tick, length, key], ni) =>
        addNote(d, patternId, ch.id, { id: `n${ci}_${ni}` as NoteId, tick, length, key, velocity: 1 }),
      );
    });
  });
  return { project, patternId, channels, ins: [...ins] };
}

/** Adds an effect (default params plus `params`) to an insert; returns the slot. */
export function addEffect(
  d: Parameters<typeof addFxSlot>[0],
  insertId: InsertId,
  def: PluginDef,
  params: Record<string, ParamValue> = {},
): SlotId {
  const slot = addFxSlot(
    d,
    insertId,
    makePluginInstance(def.id, def.version, { ...defaultValues(def.params), ...params }),
  );
  if (!slot) throw new Error('insert is full');
  return slot;
}

/**
 * Applies each document in turn to one offline engine (the first as a load, the rest as edits),
 * lets `inspect` look at the engine once everything has loaded, then renders `bars` bars.
 */
export async function renderDocs(
  docs: readonly Project[],
  patternId: PatternId,
  plugins: PluginResolver,
  opts: { bars?: number; inspect?(engine: Engine): void } = {},
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(SR * (2 * (opts.bars ?? 1) + 1)),
    sampleRate: SR,
  });
  const engine = new Engine(ctx, { plugins }, true);
  let prev: Project | null = null;
  for (const next of docs) {
    engine.applyDocChange(
      prev ? { next, prev, patches: [], origin: 'edit' } : { next, prev: next, patches: null, origin: 'load' },
    );
    prev = next;
  }
  engine.setTransportView({ mode: 'pattern', patternId, loop: null });
  await engine.ready();
  opts.inspect?.(engine);
  const preRoll = 2048 / SR;
  engine.startOffline(0, preRoll);
  engine.pumpOffline(preRoll + engine.barSeconds() * (opts.bars ?? 1) - 1e-6);
  await engine.syncWorklets();
  const buffer = await ctx.startRendering();
  await engine.dispose();
  return buffer;
}

/** Index of the largest |sample| of channel 0. */
export function argmax(buffer: AudioBuffer, channel = 0): number {
  const d = buffer.getChannelData(channel);
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

/** RMS of channel 0 over [from, to). */
export function rmsRange(buffer: AudioBuffer, from: number, to: number, channel = 0): number {
  const d = buffer.getChannelData(channel);
  let sum = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(d.length, Math.floor(to));
  for (let i = a; i < b; i++) sum += (d[i] as number) ** 2;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/** Largest |a[i + shift] − b[i]| over both channels (a shifted left by `shift`). */
export function maxDiffShifted(a: AudioBuffer, b: AudioBuffer, shift: number, scaleB = 1): number {
  let diff = 0;
  for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) {
    const x = a.getChannelData(c);
    const y = b.getChannelData(c);
    for (let i = 0; i + shift < x.length && i < y.length; i++)
      diff = Math.max(diff, Math.abs((x[i + shift] as number) - scaleB * (y[i] as number)));
  }
  return diff;
}
