import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const LIMITER_ID = 'agstudio.limiter';

/** The look-ahead: the gain ramps down over this long before a peak arrives. */
const LOOKAHEAD_SECONDS = 0.005;
/**
 * The true-peak detector sees a sample 8 frames after it arrives, and the point it reconstructs
 * between two samples depends on the 7 before and 8 after them: the gain is held flat over all of
 * them, so the latency is the look-ahead plus 14 frames.
 */
const DETECTOR_FRAMES = 14;

/** Frames of the attack ramp (the look-ahead) at a sample rate. */
export function lookaheadFrames(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * LOOKAHEAD_SECONDS));
}

/** Frames the limiter delays its audio by (reported as latency, so the mixer compensates it). */
export function latencyFrames(sampleRate: number): number {
  return lookaheadFrames(sampleRate) + DETECTOR_FRAMES;
}

export const limiterParams = {
  input: p.float(0, 24, 0, {
    label: 'Input gain',
    unit: 'dB',
    group: 'Limiter',
    hint: 'Pushes the sound into the limiter: louder overall, with more limiting',
  }),
  ceiling: p.float(-12, 0, -1, {
    label: 'Ceiling',
    unit: 'dB',
    group: 'Limiter',
    hint: 'The level the output never goes above (−1 dB is a safe choice for streaming)',
  }),
  release: p.float(1, 1000, 80, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Limiter',
    hint: 'How fast the volume comes back after a peak: short is louder but can distort, long is smoother',
  }),
  truePeak: p.bool(true, {
    label: 'True peak',
    group: 'Limiter',
    hint: 'Also catches peaks between samples, the ones converters and MP3/AAC encoders turn into clipping',
  }),
};
