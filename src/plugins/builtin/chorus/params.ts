import { p } from '@agstudio/sdk/params';
import { SYNC_LABELS, SYNC_OPTIONS } from '@agstudio/sdk/dsp/tempo';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const CHORUS_ID = 'agstudio.chorus';

/** Beats per cycle of each Sync option (0 = free-running), for the kernel. */
export { SYNC_BEATS } from '@agstudio/sdk/dsp/tempo';

export const chorusParams = {
  rate: p.float(0.05, 8, 0.6, {
    label: 'Rate',
    unit: 'Hz',
    scale: 'log',
    group: 'Motion',
    hint: 'How fast the voices drift, in cycles per second (used when Sync is off)',
  }),
  sync: p.enum(SYNC_OPTIONS, 'off', {
    label: 'Sync',
    group: 'Motion',
    labels: SYNC_LABELS,
    hint: 'Locks the drift to the song: one cycle per note length. Off uses the Rate knob',
  }),
  depth: p.float(0, 1, 0.5, {
    label: 'Depth',
    unit: '%',
    group: 'Motion',
    hint: 'How far the voices drift in pitch: more is wobblier',
  }),
  delay: p.float(5, 30, 12, {
    label: 'Delay',
    unit: 'ms',
    group: 'Voices',
    hint: 'How far behind the voices play: short is tight and shimmery, long is lush and doubled',
  }),
  voices: p.int(1, 4, 2, {
    label: 'Voices',
    group: 'Voices',
    hint: 'Copies of the sound on each side: more voices, thicker chorus',
  }),
  width: p.float(0, 1, 0.8, {
    label: 'Width',
    unit: '%',
    group: 'Voices',
    hint: 'How far the voices spread between left and right (0% = the same on both sides)',
  }),
  feedback: p.float(0, 0.7, 0, {
    label: 'Feedback',
    unit: '%',
    group: 'Voices',
    hint: 'Feeds the voices back into themselves for a metallic, flanger-like edge',
  }),
  mix: p.float(0, 1, 0.5, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'How much chorus is blended with the original (50% is the classic sound)',
  }),
};
