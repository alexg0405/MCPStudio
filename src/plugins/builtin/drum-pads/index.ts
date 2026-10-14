import { defineWorkletInstrument, type ParamValue } from '@agstudio/sdk';
import processor from './drum-pads.worklet.ts?worker&url';
import type { SoundsMessage } from './kernel';
import { DRUM_PADS_ID, drumPadsParams, FULL_DECAY, PAD_SLOTS, padParam, SOUND_IDS, type SoundId } from './params';
import { builtinSound } from './sounds.kernel';
import { DrumPadsUI } from './ui';

interface PadSettings {
  sound?: SoundId;
  tune?: number;
  level?: number;
  pan?: number;
  decay?: number;
  reverse?: boolean;
  choke?: number;
}

/** Preset params from per-pad settings (pads left out keep the General MIDI defaults). */
function kit(pads: Record<number, PadSettings>, extra: Record<string, ParamValue> = {}): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...extra };
  for (const [n, s] of Object.entries(pads)) {
    const id = padParam(Number(n));
    if (s.sound !== undefined) out[id.sound] = s.sound;
    if (s.tune !== undefined) out[id.tune] = s.tune;
    if (s.level !== undefined) out[id.level] = s.level;
    if (s.pan !== undefined) out[id.pan] = s.pan;
    if (s.decay !== undefined) out[id.decay] = s.decay;
    if (s.reverse !== undefined) out[id.reverse] = s.reverse;
    if (s.choke !== undefined) out[id.choke] = s.choke;
  }
  return out;
}

/**
 * Drum Pads (FPC-style): 16 pads on keys 36–51, each playing a sample slot (`pad1`…`pad16`) or a
 * built-in drum sound while empty. The built-in sounds are rendered on the main thread once per
 * sample rate (a few milliseconds) and sent to the kernel, so the audio thread never stalls.
 */
export default defineWorkletInstrument({
  id: DRUM_PADS_ID,
  name: 'Drum Pads',
  version: 1,
  category: 'Drums',
  description:
    'Sixteen drum pads on keys 36–51 (C3 up, General MIDI layout) that play your own samples or built-in drum sounds, with tune, level, pan, decay, reverse and choke groups per pad.',
  params: drumPadsParams,
  processor,
  sampleSlots: PAD_SLOTS,
  samplePickers: false,
  tailTime: 4,
  ui: DrumPadsUI,
  setup(port, host) {
    const sampleRate = host.audioContext.sampleRate;
    const msg: SoundsMessage = {
      type: 'sounds',
      sampleRate,
      sounds: SOUND_IDS.map((id) => builtinSound(id, sampleRate)),
    };
    port.send(msg);
  },
  presets: [
    { name: 'GM kit (default)', params: {} },
    {
      name: 'Trap 808 kit',
      params: kit({
        1: { sound: 'kick808', tune: -2 },
        2: { tune: 3, level: -4 },
        3: { sound: 'snare2', tune: 3, decay: 0.35 },
        4: { tune: 1, level: -1 },
        5: { sound: 'snap', level: -2 },
        7: { tune: 4, level: -5, decay: 0.07, pan: 0.15 },
        9: { tune: 2, level: -6, pan: 0.15 },
        11: { tune: 2, decay: 0.6, level: -5, pan: 0.15 },
        14: { tune: -3, level: -6 },
        16: { sound: 'cowbell', tune: 2, level: -8 },
      }),
    },
    {
      name: 'Boom bap kit',
      params: kit({
        1: { tune: -1, decay: 0.6 },
        2: { tune: -1, level: -3 },
        3: { tune: -2 },
        4: { sound: 'snare', tune: -4, decay: 0.3, level: -4 },
        7: { tune: -2, level: -6, pan: -0.1 },
        9: { tune: -2, level: -8, pan: -0.1 },
        11: { tune: -2, level: -7, decay: 0.45, pan: -0.1 },
        16: { tune: -2, level: -9 },
      }),
    },
    {
      name: 'House kit',
      params: kit({
        1: { sound: 'kickHard', tune: -2, decay: 0.45 },
        3: { sound: 'snare2', level: -3 },
        4: { tune: 1 },
        7: { tune: 2, level: -5, decay: 0.06 },
        8: { sound: 'shaker', level: -8, pan: 0.3 },
        11: { tune: 2, level: -4, decay: 0.35 },
        12: { sound: 'conga', level: -4, pan: -0.25 },
        16: { tune: 1, level: -6 },
      }),
    },
    {
      name: 'Lo-fi kit (tuned down)',
      params: kit(
        {
          1: { tune: -4, decay: 0.5 },
          2: { tune: -4 },
          3: { tune: -5, decay: 0.25 },
          4: { tune: -4, decay: 0.3 },
          7: { tune: -6, level: -6 },
          9: { tune: -6, level: -7 },
          11: { tune: -6, decay: 0.3, level: -6 },
          14: { tune: -5, decay: 0.8, level: -6 },
        },
        { level: -2 },
      ),
    },
    {
      name: 'Reverse FX kit',
      params: kit({
        1: { sound: 'kick808', tune: -5 },
        3: { reverse: true, decay: FULL_DECAY },
        4: { reverse: true },
        11: { reverse: true, choke: 0 },
        14: { reverse: true, tune: -5 },
        16: { reverse: true },
      }),
    },
  ],
});
