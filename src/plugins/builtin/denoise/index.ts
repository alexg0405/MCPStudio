import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './denoise.worklet.ts?worker&url';
import type { DenoiseState, ProfileMessage } from './kernel';
import { DENOISE_ID, denoiseLatencyFrames, denoiseParams } from './params';

/** Decimals kept of each bin's level (dB) in the saved profile: enough to hear no difference, small to save. */
const PROFILE_PLACES = 10;

/** True for the message the kernel posts when a learn ends. */
function isProfileMessage(msg: unknown): msg is ProfileMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'profile';
}

/**
 * Real-time noise reduction for monitoring and live input (worklet kernel, one 1024-sample frame of latency that the
 * host compensates). Switch Learn on while only the room is heard and off again: the noise is remembered with the
 * project. Before that it follows the quietest sound it hears. For a finished recording, the playlist's
 * Clean up vocal does the same offline, with a better result.
 */
export default defineWorkletEffect<typeof denoiseParams, DenoiseState>({
  id: DENOISE_ID,
  name: 'Denoise',
  version: 1,
  category: 'Voice',
  description:
    'Turns steady background noise (hiss, hum, fan, room tone) down in a voice or an instrument while you monitor or record. Learn the noise once, or let it follow the quietest sound. For a finished recording, use Clean up vocal on the clip.',
  params: denoiseParams,
  defaultState: {},
  processor,
  // The kernel posts the learned noise when Learn is switched off: keep it in the plugin's state so it is saved and undoable.
  setup(port, host) {
    return port.onMessage((msg) => {
      if (!isProfileMessage(msg)) return;
      const profile = Array.from(msg.bins, (v) => Math.round(v * PROFILE_PLACES) / PROFILE_PLACES);
      host.updateState({ profile, frames: msg.frames });
    });
  },
  latency: (sampleRate) => denoiseLatencyFrames(sampleRate) / sampleRate,
  tap: true,
  meters: [
    {
      reading: 'gr',
      label: 'Noise reduction',
      kind: 'reduction',
      max: 30,
      hint: 'How much the noise is turned down right now, averaged over all frequencies. It sits at the Reduction setting when only noise is playing and eases off while you sing',
    },
  ],
  tailTime: 0.05,
  presets: [
    { name: 'Gentle (monitoring)', params: { amount: 6, sensitivity: 0.4 } },
    { name: 'Normal (12 dB)', params: { amount: 12, sensitivity: 0.5 } },
    { name: 'Strong (fan or hiss)', params: { amount: 20, sensitivity: 0.65 } },
    { name: 'Podcast (clean between words)', params: { amount: 24, sensitivity: 0.7 } },
  ],
});
