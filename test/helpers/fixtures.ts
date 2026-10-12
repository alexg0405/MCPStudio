import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { KIT_VERSION } from '@core/model/kit';
import type { ChannelId, PatternId, Project, SampleRef } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { setStep } from '@core/ops/notes';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import sampler from '../../src/plugins/builtin/sampler';

export const resolver = (...defs: PluginDef[]) => {
  const all = new Map<string, PluginDef>([[sampler.id, sampler as PluginDef], ...defs.map((d) => [d.id, d] as const)]);
  return { get: (id: string) => all.get(id) };
};

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
