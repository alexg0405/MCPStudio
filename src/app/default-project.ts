import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { KIT_VERSION, kitPiece } from '@core/model/kit';
import type { InstrumentChannel, Project, SampleRef } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import type { PluginRegistry } from './plugins/registry';

export const SAMPLER_ID = 'agstudio.sampler';

export function kitSampleRef(generator: string): SampleRef {
  return {
    id: newId.sample(),
    name: kitPiece(generator)?.name ?? generator,
    source: { kind: 'builtin', generator, version: KIT_VERSION },
  };
}

/** A new instrument channel with the plugin's default params. */
export function instrumentChannelFor(
  def: PluginDef,
  name: string,
  index: number,
  samples?: Record<string, SampleRef['id']>,
): InstrumentChannel {
  return makeInstrumentChannel(
    name,
    makePluginInstance(def.id, def.version, defaultValues(def.params), samples ? { samples } : {}),
    { color: paletteColor(index) },
  );
}

/** FL's default template: Kick, Clap, Hat and Snare on samplers, one empty pattern. */
export function createDefaultProject(registry: PluginRegistry): Project {
  const empty = createEmptyProject();
  const sampler = registry.get(SAMPLER_ID);
  if (!sampler) return empty;
  const pieces: [string, string][] = [
    ['kit/kick', 'Kick'],
    ['kit/clap', 'Clap'],
    ['kit/hat-closed', 'Hat'],
    ['kit/snare', 'Snare'],
  ];
  return produce(empty, (d) => {
    pieces.forEach(([generator, name], i) => {
      const sample = kitSampleRef(generator);
      addSample(d, sample);
      addChannel(d, instrumentChannelFor(sampler, name, i, { main: sample.id }));
    });
  });
}
