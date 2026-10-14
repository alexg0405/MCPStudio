import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { KIT_VERSION } from '@core/model/kit';
import type { ChannelId, InsertId, PatternId, Project, SampleRef, SlotId } from '@core/model/types';
import { addChannel, addSample, setChannelProp } from '@core/ops/channels';
import { addFxSlot, setFxSlotEnabled, setFxSlotMix, setInsertProp } from '@core/ops/mixer';
import { setStep } from '@core/ops/notes';
import { defaultValues, type ParamValue, type PluginDef } from '@agstudio/sdk';
import sampler from '../../src/plugins/builtin/sampler';
import bass808 from '../../src/plugins/builtin/bass808';
import eq from '../../src/plugins/builtin/eq';
import filter from '../../src/plugins/builtin/filter';
import delay from '../../src/plugins/builtin/delay';
import reverb from '../../src/plugins/builtin/reverb';
import compressor from '../../src/plugins/builtin/compressor';
import distortion from '../../src/plugins/builtin/distortion';
import ducker from '../../src/plugins/builtin/ducker';
import gate from '../../src/plugins/builtin/gate';
import bitcrusher from '../../plugins/example-bitcrusher';
import { M14_EFFECTS } from './effects';

/**
 * Every effect the mixer tests use: the built-ins plus the example worklet effect. Sidechain effects
 * key from their own input when no sidechain is chosen, so their presets change the sound here too.
 */
export const EFFECTS: readonly PluginDef[] = [
  eq,
  filter,
  delay,
  reverb,
  compressor,
  distortion,
  ducker,
  gate,
  bitcrusher,
  ...M14_EFFECTS,
];

/** Instruments the tests use. */
export const INSTRUMENTS: readonly PluginDef[] = [sampler, bass808];

/** Resolves every instrument in INSTRUMENTS, every effect in EFFECTS, and any extra definitions. */
export const resolver = (...defs: PluginDef[]) => {
  const all = new Map<string, PluginDef>([
    ...INSTRUMENTS.map((d) => [d.id, d] as const),
    ...EFFECTS.map((d) => [d.id, d] as const),
    ...defs.map((d) => [d.id, d] as const),
  ]);
  return { get: (id: string) => all.get(id) };
};

export interface FxSpec {
  def: PluginDef;
  params?: Record<string, ParamValue>;
  enabled?: boolean;
  mix?: number;
}

/**
 * Routes `channels` to mixer insert `index` (1 = "Insert 1") and fills its effect slots in order.
 */
export function withInsert(
  project: Project,
  channels: readonly ChannelId[],
  opts: { index?: number; fx?: FxSpec[]; volume?: number; muted?: boolean } = {},
): { project: Project; insertId: InsertId; slots: SlotId[] } {
  const insertId = project.mixer.order[opts.index ?? 1] as InsertId;
  const slots: SlotId[] = [];
  const next = produce(project, (d) => {
    for (const id of channels) setChannelProp(d, id, 'output', insertId);
    if (opts.volume !== undefined) setInsertProp(d, insertId, 'volume', opts.volume);
    if (opts.muted !== undefined) setInsertProp(d, insertId, 'muted', opts.muted);
    for (const fx of opts.fx ?? []) {
      const plugin = makePluginInstance(fx.def.id, fx.def.version, { ...defaultValues(fx.def.params), ...fx.params });
      const slot = addFxSlot(d, insertId, plugin);
      if (!slot) throw new Error('insert is full');
      slots.push(slot);
      if (fx.enabled !== undefined) setFxSlotEnabled(d, insertId, slot, fx.enabled);
      if (fx.mix !== undefined) setFxSlotMix(d, insertId, slot, fx.mix);
    }
  });
  return { project: next, insertId, slots };
}

/** Largest absolute difference between two renders (all channels). */
export function maxDiff(a: AudioBuffer, b: AudioBuffer): number {
  let diff = a.length === b.length ? 0 : Infinity;
  for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) {
    const x = a.getChannelData(c);
    const y = b.getChannelData(c);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      diff = Math.max(diff, Math.abs((x[i] as number) - (y[i] as number)));
  }
  return diff;
}

/** A project with one sampler channel per kit piece, each with the given steps. */
export function kitProject(
  tracks: { generator: string; steps: number[] }[],
  bpm = 120,
): { project: Project; patternId: PatternId; channels: ChannelId[] } {
  let project = createEmptyProject();
  const patternId = project.patternOrder[0] as PatternId;
  const channels: ChannelId[] = [];
  project = produce(project, (d) => {
    d.transport.bpm = bpm;
    for (const t of tracks) {
      const sample: SampleRef = {
        id: newId.sample(),
        name: t.generator,
        source: { kind: 'builtin', generator: t.generator, version: KIT_VERSION },
      };
      addSample(d, sample);
      const ch = makeInstrumentChannel(
        t.generator,
        makePluginInstance(sampler.id, sampler.version, defaultValues(sampler.params), {
          samples: { main: sample.id },
        }),
      );
      addChannel(d, ch);
      channels.push(ch.id);
      for (const s of t.steps) setStep(d, patternId, ch.id, s, true, { rootKey: 60, velocity: 1 });
    }
  });
  return { project, patternId, channels };
}

/** Frames where the signal first rises above `threshold` after at least `gap` seconds of quiet. */
export function onsets(buffer: AudioBuffer, threshold = 0.05, gap = 0.05): number[] {
  const data = buffer.getChannelData(0);
  const minGap = Math.round(gap * buffer.sampleRate);
  const out: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i] as number) > threshold) {
      if (i - lastLoud > minGap) out.push(i);
      lastLoud = i;
    }
  }
  return out;
}

export function peak(buffer: AudioBuffer): number {
  let m = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i] as number));
  }
  return m;
}

export function rms(buffer: AudioBuffer): number {
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) sum += (d[i] as number) ** 2;
    n += d.length;
  }
  return Math.sqrt(sum / Math.max(1, n));
}
