import { useEffect, useReducer, useRef } from 'react';
import { KIT, kitPiece } from '@core/model/kit';
import type { PluginOwner } from '@core/model/types';
import { pluginInstanceOf } from '@core/query/mixer';
import type { PluginDef, PluginUISamples } from '@agstudio/sdk';
import { importAudioFile, pickAudioFile, setPluginSlotSample } from '@app/actions/samples';
import { kitSampleRef } from '@app/default-project';
import type { Services } from '@app/services';
import { dragMayHaveAudio, KIT_SOUND_TYPE, takeAudioFiles } from '../../audio-drag';
import { useServices } from '../../services-context';

const KIT_SOUNDS = KIT.map((k) => ({ id: k.generator, name: k.name }));

async function loadFile(s: Services, owner: PluginOwner, slot: string, file: File | null | undefined) {
  if (!file) return;
  const ref = await importAudioFile(s, file);
  if (ref) setPluginSlotSample(s, owner, slot, ref);
}

/**
 * Sample slots for a custom plugin editor (`PluginUIProps.samples`): names, the file chooser, drops
 * from the desktop, the sample browser and the browser panel's kit sounds, and waveforms. Every
 * change is one undo step. Re-renders the editor when a waveform it asked for finishes decoding.
 */
export function usePluginSamples(owner: PluginOwner, def: PluginDef | undefined): PluginUISamples | undefined {
  const services = useServices();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const waiting = useRef(false);
  useEffect(
    () =>
      services.engine.subscribe(() => {
        if (!waiting.current) return;
        waiting.current = false;
        refresh();
      }),
    [services],
  );
  if (!def?.sampleSlots?.length) return undefined;

  const refOf = (slot: string) => {
    const project = services.doc.getState().project;
    const id = pluginInstanceOf(project, owner)?.samples?.[slot];
    return id ? project.samples[id] : undefined;
  };
  const loadKit = (slot: string, id: string) => {
    if (kitPiece(id)) setPluginSlotSample(services, owner, slot, kitSampleRef(id));
  };
  return {
    name: (slot) => refOf(slot)?.name ?? null,
    choose: (slot) => void pickAudioFile().then((file) => loadFile(services, owner, slot, file)),
    kit: KIT_SOUNDS,
    loadKit,
    clear: (slot) => {
      if (refOf(slot)) setPluginSlotSample(services, owner, slot, null);
    },
    canDrop: (data) => data.types.includes(KIT_SOUND_TYPE) || dragMayHaveAudio(data),
    drop: (slot, data) => {
      const generator = data.getData(KIT_SOUND_TYPE);
      if (generator) {
        loadKit(slot, generator);
        return true;
      }
      const files = takeAudioFiles(data);
      if (!files) return false;
      void files.then((list) => loadFile(services, owner, slot, list[0]));
      return true;
    },
    waveform: (slot) => {
      const ref = refOf(slot);
      if (!ref) return null;
      const overview = services.engine.waveform(ref);
      if (!overview) waiting.current = true;
      return overview;
    },
  };
}
