import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const REVERB_ID = 'agstudio.reverb';

export const REVERB_ENGINES = ['algorithmic', 'convolution'] as const;
export type ReverbEngine = (typeof REVERB_ENGINES)[number];

export const reverbParams = {
  decay: p.float(0.2, 10, 2.2, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Room',
    hint: 'Time for the reverb to fade by 60 dB (RT60)',
    // The convolution engine rebuilds its impulse response on each change: not for automation.
    automatable: false,
  }),
  preDelay: p.float(0, 0.2, 0.02, {
    label: 'Pre-delay',
    unit: 's',
    group: 'Room',
    hint: 'Gap before the reverb starts',
  }),
  damping: p.float(0, 1, 0.5, {
    label: 'Damping',
    unit: '%',
    group: 'Room',
    hint: 'How much faster the highs die away',
    automatable: false,
  }),
  size: p.float(0, 1, 0.6, {
    label: 'Size',
    unit: '%',
    group: 'Room',
    hint: 'Room size: how far apart the early reflections are',
    automatable: false,
  }),
  mix: p.float(0, 1, 0.3, { label: 'Mix', unit: '%', group: 'Output', hint: 'Dry/wet balance (equal power)' }),
  engine: p.enum(REVERB_ENGINES, 'algorithmic', {
    label: 'Engine',
    group: 'Engine',
    labels: { algorithmic: 'Algorithmic', convolution: 'Convolution' },
    hint: 'Algorithmic: light on the CPU, any length (default). Convolution: the original sound, heavy with long tails',
  }),
};

/**
 * Seconds the reverb keeps sounding after its input stops (export padding): the pre-delay, the
 * longest delay line and 1.3 × RT60 (about −78 dB).
 */
export function reverbTail(decay: number, preDelay: number): number {
  return preDelay + 0.1 + decay * 1.3;
}
