import { p } from '@agstudio/sdk/params';
import { SYNC_LABELS, SYNC_OPTIONS } from '@agstudio/sdk/dsp/tempo';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const FLANGER_ID = 'agstudio.flanger';
export { SYNC_BEATS } from '@agstudio/sdk/dsp/tempo';

export const flangerParams = {
  rate: p.float(0.02, 5, 0.25, {
    label: 'Rate',
    unit: 'Hz',
    scale: 'log',
    group: 'Motion',
    hint: 'How fast the sweep goes up and down, in cycles per second (used when Sync is off)',
  }),
  sync: p.enum(SYNC_OPTIONS, 'off', {
    label: 'Sync',
    group: 'Motion',
    labels: SYNC_LABELS,
    hint: 'Locks the sweep to the song: one cycle per note length. Off uses the Rate knob',
  }),
  depth: p.float(0, 1, 0.7, {
    label: 'Depth',
    unit: '%',
    group: 'Motion',
    hint: 'How far the sweep travels: more is a bigger "whoosh"',
  }),
  delay: p.float(0.2, 10, 1.5, {
    label: 'Delay',
    unit: 'ms',
    scale: 'log',
    group: 'Sound',
    hint: 'Where the sweep starts: short is high and airy, long is lower and more chorus-like',
  }),
  feedback: p.float(-0.95, 0.95, 0.5, {
    label: 'Feedback',
    unit: '%',
    group: 'Sound',
    hint: 'Resonance of the sweep: above 0% metallic and ringing, below 0% hollow',
  }),
  width: p.float(0, 1, 0.5, {
    label: 'Width',
    unit: '%',
    group: 'Sound',
    hint: 'How far apart the left and right sweeps are (0% = both sides together)',
  }),
  mix: p.float(0, 1, 0.5, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'How much flanging is blended in (50% gives the deepest sweep)',
  }),
};
