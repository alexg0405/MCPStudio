import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const SLICER_ID = 'agstudio.slicer';

/** Slice 1 plays on key 60 (C5 in FL's naming), slice 2 on 61, and so on. */
export const FIRST_KEY = 60;
/** At most this many slices (keys 60–123). */
export const MAX_SLICES = 64;

export const slicerParams = {
  mode: p.enum(['transients', 'grid'], 'transients', {
    label: 'Slice by',
    labels: { transients: 'Hits (transients)', grid: 'Even grid' },
    group: 'Slicing',
    hint: 'Cut where each hit starts, or into equal parts (for loops)',
    automatable: false,
  }),
  sensitivity: p.float(0, 1, 0.5, {
    label: 'Sensitivity',
    unit: '%',
    group: 'Slicing',
    hint: 'How readily a hit starts a new slice: more finds softer hits (more slices)',
    automatable: false,
  }),
  gridSlices: p.int(1, 64, 16, {
    label: 'Grid slices',
    group: 'Slicing',
    hint: 'How many equal slices on the even grid: 16 = sixteenth notes of a one-bar loop',
    automatable: false,
  }),
  minSlice: p.float(10, 1000, 80, {
    label: 'Shortest slice',
    unit: 'ms',
    scale: 'log',
    group: 'Slicing',
    hint: 'Hits closer together than this stay in one slice',
    automatable: false,
  }),
  playback: p.enum(['oneshot', 'gated'], 'oneshot', {
    label: 'Playback',
    labels: { oneshot: 'One-shot (plays the whole slice)', gated: 'Gated (stops when you let go)' },
    group: 'Playback',
    hint: 'One-shot plays each slice to its end; gated stops it when the note ends',
  }),
  cut: p.bool(true, {
    label: 'Cut',
    group: 'Playback',
    hint: 'A new slice stops the one playing, like chopping a break (off: slices ring together)',
  }),
  tune: p.float(-24, 24, 0, {
    label: 'Tune',
    unit: 'st',
    group: 'Playback',
    hint: 'Pitch in semitones (like a sampler: lower is also slower)',
  }),
  reverse: p.bool(false, { label: 'Reverse', group: 'Playback', hint: 'Plays each slice backwards' }),
  attack: p.float(0, 200, 1, {
    label: 'Attack',
    unit: 'ms',
    group: 'Playback',
    hint: 'Fade-in at the start of each slice (a little avoids clicks; more softens hits)',
  }),
  release: p.float(5, 2000, 40, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Playback',
    hint: 'Fade-out when a gated slice is let go',
  }),
  velocity: p.float(0, 1, 0.6, {
    label: 'Velocity',
    unit: '%',
    group: 'Playback',
    hint: 'How much harder notes play louder (0% = every slice the same)',
  }),
  level: p.float(-36, 6, -3, { label: 'Volume', unit: 'dB', scale: 'db', group: 'Playback', hint: 'Overall level' }),
};

export type SlicerParams = typeof slicerParams;
