import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DENOISE_ID = 'agstudio.denoise';

/** Frames of the Denoise transform: 1024 up to 50 kHz (21 ms at 48 kHz), 2048 above. Its latency is one whole frame. */
export function denoiseFrames(sampleRate: number): number {
  return sampleRate > 50000 ? 2048 : 1024;
}

/** Frames Denoise delays its audio by: a whole transform frame (overlap-add needs all four windows of a sample). */
export function denoiseLatencyFrames(sampleRate: number): number {
  return denoiseFrames(sampleRate);
}

/** Most the noise is turned down, dB. */
export const DENOISE_MAX_REDUCTION_DB = 30;

export const denoiseParams = {
  amount: p.float(0, DENOISE_MAX_REDUCTION_DB, 12, {
    label: 'Reduction',
    unit: 'dB',
    group: 'Noise',
    hint: 'How far the noise is turned down. 6–12 dB is natural; more takes out more noise but can make the voice sound thin or watery. Sounds that rise above the noise are left alone',
  }),
  sensitivity: p.float(0, 1, 0.5, {
    label: 'Sensitivity',
    unit: '%',
    group: 'Noise',
    hint: 'How far above the noise a sound must rise to count as voice. Higher cuts more noise between words but can dull soft consonants and quiet endings',
  }),
  learn: p.bool(false, {
    label: 'Learn noise',
    group: 'Noise',
    hint: 'Switch on while only the room is heard (stay quiet for a second or two), then switch off: the noise is remembered with the project. Without a learned noise it follows the quietest sound it hears',
  }),
  listen: p.bool(false, {
    label: 'Hear noise only',
    group: 'Output',
    hint: 'Plays only what is being taken out, so you can check that no voice is in it. Turn it off again before you record or bounce',
  }),
};
