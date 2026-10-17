import { LIMITER_DETECTOR_FRAMES } from '@agstudio/sdk/dsp/lookahead-limiter';
import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const MAXIMIZER_ID = 'agstudio.maximizer';

/** The first stage's look-ahead: the gain ramps down over this long before a peak arrives. */
const LOOKAHEAD_SECONDS = 0.005;

/** Frames of the first stage's attack ramp. */
export function lookaheadFrames(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * LOOKAHEAD_SECONDS));
}

/** Frames the Maximizer delays its audio by (reported as latency, so the mixer compensates it). */
export function latencyFrames(sampleRate: number): number {
  return lookaheadFrames(sampleRate) + LIMITER_DETECTOR_FRAMES;
}

/** The deepest peak clip (dB): beyond it the soft curve would have to fold back on itself. */
export const MAX_CLIP_DB = 4;

export const maximizerParams = {
  input: p.float(0, 24, 0, {
    label: 'Input gain',
    unit: 'dB',
    group: 'Maximizer',
    hint: 'Pushes the sound in: louder overall. The peaks are eased down by a limiter and a soft clip, so it stays clearer than a limiter alone',
  }),
  ceiling: p.float(-12, 0, -1, {
    label: 'Ceiling',
    unit: 'dB',
    group: 'Maximizer',
    hint: 'The level the peaks are brought to (put a Limiter with the same ceiling after it to catch the last stray peak)',
  }),
  clip: p.float(0, MAX_CLIP_DB, 2, {
    label: 'Peak clip',
    unit: 'dB',
    group: 'Soft clip',
    hint: 'How many dB of the loudest peaks are rounded off by a soft clip instead of squeezed by the limiter: 0 is off, 2 dB is gentle, 4 dB is the most',
  }),
  knee: p.float(1, 8, 3, {
    label: 'Softness',
    unit: 'dB',
    group: 'Soft clip',
    hint: 'How far under the ceiling the soft clip starts to bend the peaks: bigger is softer and rounder, smaller is sharper',
  }),
  release: p.float(1, 1000, 80, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Maximizer',
    hint: 'How fast the volume comes back after a peak: short is louder but can distort, long is smoother',
  }),
};
