import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './vocoder.worklet.ts?worker&url';
import { VOCODER_ID, vocoderParams } from './params';

/**
 * Channel vocoder: put it on a synth track and choose the vocal track under the slot's
 * "Sidechain from" menu; the synth then speaks with the voice's words. Without a sidechain it
 * vocodes the track with itself (a band-filtered, enveloped version of the sound).
 */
export default defineWorkletEffect({
  id: VOCODER_ID,
  name: 'Vocoder',
  version: 1,
  category: 'Voice',
  description:
    'Makes a synth talk: the voice comes from the sidechain ("Sidechain from" the vocal track) and the synth on this track sings its words.',
  params: vocoderParams,
  processor,
  sidechain: true,
  tailTime: 0.3,
  presets: [
    {
      name: 'Classic robot voice',
      params: { bands: '16', width: 0.8, attack: 3, release: 40, sibilance: 0.2, noise: 0.05 },
    },
    {
      name: 'Bright 32-band vocoder',
      params: { bands: '32', width: 1, attack: 2, release: 50, sibilance: 0.4, noise: 0.1 },
    },
    {
      name: 'Whispery (noise carrier)',
      params: { bands: '24', width: 1.4, attack: 5, release: 80, sibilance: 0.5, noise: 0.8 },
    },
    { name: 'Deep formant down', params: { bands: '24', formant: -5, attack: 4, release: 60, sibilance: 0.3 } },
    {
      name: 'Talking synth pad',
      params: { bands: '24', width: 1.6, attack: 15, release: 200, sibilance: 0.1, noise: 0 },
    },
    { name: 'Tiny chipmunk formant', params: { bands: '32', formant: 7, attack: 2, release: 40, sibilance: 0.4 } },
  ],
});
