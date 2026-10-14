import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const LOFI_ID = 'agstudio.lofi';

/** The wobble needs room in its delay line: the effect delays everything by this much (latency). */
const WOBBLE_SECONDS = 0.008;

/** Frames the Lo-Fi delays its audio by (the centre of the wow/flutter delay line). */
export function lofiLatencyFrames(sampleRate: number): number {
  return Math.round(sampleRate * WOBBLE_SECONDS);
}

export const lofiParams = {
  bits: p.float(1, 16, 12, {
    label: 'Bit depth',
    group: 'Crush',
    hint: 'Fewer bits, more grit: 16 is clean, 12 an old sampler, 8 a game console, 4 and below destroyed',
  }),
  rate: p.float(1000, 48000, 26000, {
    label: 'Sample rate',
    unit: 'Hz',
    scale: 'log',
    group: 'Crush',
    hint: 'Lower rates sound grainier and add metallic aliasing (48 kHz = no change)',
  }),
  wow: p.float(0, 1, 0.2, {
    label: 'Wow',
    unit: '%',
    group: 'Wobble',
    hint: 'Slow, seasick pitch wobble like a warped record or a stretched tape',
  }),
  flutter: p.float(0, 1, 0.1, {
    label: 'Flutter',
    unit: '%',
    group: 'Wobble',
    hint: 'Fast, fine pitch wobble like a worn cassette motor',
  }),
  crackle: p.float(0, 1, 0, {
    label: 'Crackle',
    unit: '%',
    group: 'Noise',
    hint: 'Vinyl clicks and pops: more is busier and louder',
  }),
  noise: p.float(0, 1, 0.05, {
    label: 'Hiss',
    unit: '%',
    group: 'Noise',
    hint: 'Tape and vinyl hiss under the sound',
  }),
  tone: p.float(500, 20000, 10000, {
    label: 'Tone',
    unit: 'Hz',
    scale: 'log',
    group: 'Tone',
    hint: 'Cuts the highs above this: lower sounds older and duller (20 kHz = no filter)',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend of the lo-fi sound with the original',
  }),
};
