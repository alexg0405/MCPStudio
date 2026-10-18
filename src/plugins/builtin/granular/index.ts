import { defineWorkletInstrument } from '@agstudio/sdk';
import { lazyUi } from '@agstudio/sdk/ui';
import processor from './granular.worklet.ts?worker&url';
import type { TextureMessage } from './kernel';
import { GRANULAR_ID, granularParams } from './params';
import { GRANULAR_PRESETS } from './presets';
import { textureChannels } from './textures';
import { TEXTURE_RATE } from './textures.kernel';

/** The shortest tail (seconds): the grains started before the release still play out, and a filter rings a moment. */
const TAIL_MIN_SECONDS = 0.5;

/**
 * Granular: every note is a cloud of tiny grains cut from a sample (drop one on the editor) or, until then, from a
 * built-in texture. Position, spray, scan and freeze move where the grains come from; size, density and shape make the
 * texture; pitch, spread and reverse scatter them. The kernel reports its newest grains to the editor, which draws
 * them as dots on the waveform.
 */
export default defineWorkletInstrument({
  id: GRANULAR_ID,
  name: 'Granular',
  version: 1,
  category: 'Samplers',
  description:
    'Granular sampler: plays clouds of tiny grains from a sample (or a built-in texture) with position, spray, grain size, density, pitch, scan and freeze, for pads, textures, glitch and rhythmic chops.',
  params: granularParams,
  processor,
  sampleSlots: ['main'],
  samplePickers: false,
  // A note's grains stop with its envelope's release; the grains already started finish within their length.
  tailTime: (v) => TAIL_MIN_SECONDS + 1.7 * Number(v.ampRelease) + Number(v.size) / 1000,
  tap: { fftSize: 256 },
  ui: lazyUi(() => import('./ui').then((m) => m.GranularUI)),
  setup(port, host) {
    const send = (id: string) => {
      const message: TextureMessage = { type: 'texture', channels: textureChannels(id), sampleRate: TEXTURE_RATE };
      port.send(message);
    };
    send(String(host.params.texture.value));
    return host.params.texture.onChange((id) => send(String(id)));
  },
  presets: GRANULAR_PRESETS,
});
