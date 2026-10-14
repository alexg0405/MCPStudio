import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DRUM_SYNTH_ID = 'agstudio.drum-synth';

const level = (group: string, what: string, def = 0) =>
  p.float(-36, 6, def, { label: 'Level', unit: 'dB', scale: 'db', group, hint: `How loud the ${what} is` });
const pan = (group: string) => p.float(-1, 1, 0, { label: 'Pan', group, hint: 'Left (−1) to right (+1)' });

export const drumSynthParams = {
  kickPitch: p.float(30, 120, 50, {
    label: 'Pitch',
    unit: 'Hz',
    scale: 'log',
    group: 'Kick',
    hint: 'Where the boom settles: lower is deeper',
  }),
  kickSweep: p.float(0, 48, 24, {
    label: 'Sweep',
    unit: 'st',
    group: 'Kick',
    hint: 'How far above the pitch each hit starts: more is punchier',
  }),
  kickSweepTime: p.float(5, 300, 45, {
    label: 'Sweep time',
    unit: 'ms',
    scale: 'log',
    group: 'Kick',
    hint: 'How fast the pitch falls: short is a tight punch, long is a laser zap',
  }),
  kickDecay: p.float(0.05, 3, 0.5, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Kick',
    hint: 'How long it rings: long for an 808 boom',
  }),
  kickClick: p.float(0, 1, 0.3, {
    label: 'Click',
    unit: '%',
    group: 'Kick',
    hint: 'A short tick at the start so it cuts through the mix',
  }),
  kickDrive: p.float(0, 1, 0.2, {
    label: 'Drive',
    unit: '%',
    group: 'Kick',
    hint: 'Saturation: warmer, fatter, louder',
  }),
  kickLevel: level('Kick', 'kick'),
  kickPan: pan('Kick'),

  snareTone: p.float(100, 400, 185, {
    label: 'Tune',
    unit: 'Hz',
    scale: 'log',
    group: 'Snare',
    hint: 'Pitch of the drum head',
  }),
  snareSnappy: p.float(0, 1, 0.6, {
    label: 'Snappy',
    unit: '%',
    group: 'Snare',
    hint: 'More rattle of the snare wires, less drum body',
  }),
  snareDecay: p.float(0.05, 1, 0.2, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Snare',
    hint: 'How long the rattle rings',
  }),
  snareBright: p.float(800, 8000, 2500, {
    label: 'Brightness',
    unit: 'Hz',
    scale: 'log',
    group: 'Snare',
    hint: 'Where the rattle starts: higher is thinner and crisper',
  }),
  snareLevel: level('Snare', 'snare'),
  snarePan: pan('Snare'),

  clapTone: p.float(500, 4000, 1200, {
    label: 'Tone',
    unit: 'Hz',
    scale: 'log',
    group: 'Clap',
    hint: 'Lower is fuller, higher is thinner',
  }),
  clapDecay: p.float(0.05, 1.5, 0.25, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Clap',
    hint: 'The room tail after the hands',
  }),
  clapSpread: p.float(4, 30, 11, {
    label: 'Spread',
    unit: 'ms',
    group: 'Clap',
    hint: 'Time between the hands clapping: wider sounds like more people',
  }),
  clapLevel: level('Clap', 'clap', -2),
  clapPan: pan('Clap'),

  chatDecay: p.float(0.01, 0.3, 0.05, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Closed hat',
    hint: 'How long the closed hat rings',
  }),
  chatTone: p.float(0, 1, 0.6, { label: 'Tone', unit: '%', group: 'Closed hat', hint: 'Darker to brighter' }),
  chatLevel: level('Closed hat', 'closed hat', -4),
  chatPan: pan('Closed hat'),

  ohatDecay: p.float(0.1, 2, 0.45, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Open hat',
    hint: 'How long the open hat rings',
  }),
  ohatTone: p.float(0, 1, 0.6, { label: 'Tone', unit: '%', group: 'Open hat', hint: 'Darker to brighter' }),
  ohatLevel: level('Open hat', 'open hat', -5),
  ohatPan: pan('Open hat'),
  hatChoke: p.bool(true, {
    label: 'Closed cuts open',
    group: 'Open hat',
    hint: 'A closed hat stops a ringing open hat, like a real hi-hat',
  }),

  tomPitch: p.float(60, 400, 120, {
    label: 'Pitch',
    unit: 'Hz',
    scale: 'log',
    group: 'Tom',
    hint: 'Pitch of the middle tom (key 45); the other tom keys play it lower or higher',
  }),
  tomSweep: p.float(0, 24, 7, {
    label: 'Sweep',
    unit: 'st',
    group: 'Tom',
    hint: 'How far above its pitch each hit starts',
  }),
  tomDecay: p.float(0.05, 1.5, 0.4, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Tom',
    hint: 'How long it rings',
  }),
  tomLevel: level('Tom', 'tom', -2),
  tomPan: pan('Tom'),

  percPitch: p.float(200, 4000, 560, {
    label: 'Pitch',
    unit: 'Hz',
    scale: 'log',
    group: 'Perc',
    hint: 'Pitch of the percussion (cowbell around 560 Hz, rim or clave higher)',
  }),
  percRing: p.float(1, 3, 1.48, {
    label: 'Metal',
    unit: 'x',
    group: 'Perc',
    hint: 'Ratio of the second tone: 1.48 is a cowbell, 1 is woody, other values clang',
  }),
  percDecay: p.float(0.02, 1, 0.15, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Perc',
    hint: 'How long it rings',
  }),
  percNoise: p.float(0, 1, 0.2, { label: 'Click', unit: '%', group: 'Perc', hint: 'A noisy tick at the start' }),
  percLevel: level('Perc', 'percussion', -6),
  percPan: pan('Perc'),

  velocity: p.float(0, 1, 0.8, {
    label: 'Velocity',
    unit: '%',
    group: 'Output',
    hint: 'How much harder hits play louder (0% = every hit the same)',
  }),
  level: p.float(-36, 6, -3, { label: 'Volume', unit: 'dB', scale: 'db', group: 'Output', hint: 'Overall level' }),
};

export type DrumSynthParams = typeof drumSynthParams;

/** The drums, and the keys that play them (General MIDI drum map). */
export const DRUMS = [
  { id: 'kick', name: 'Kick', key: 36, keys: [35, 36] },
  { id: 'perc', name: 'Perc', key: 37, keys: [37] },
  { id: 'snare', name: 'Snare', key: 38, keys: [38, 40] },
  { id: 'clap', name: 'Clap', key: 39, keys: [39] },
  { id: 'chat', name: 'Closed hat', key: 42, keys: [42, 44] },
  { id: 'tom', name: 'Tom', key: 45, keys: [41, 43, 45, 47, 48, 50] },
  { id: 'ohat', name: 'Open hat', key: 46, keys: [46] },
] as const;

export type DrumId = (typeof DRUMS)[number]['id'];

/** Semitones the tom keys play above (or below) the tom's pitch at key 45. */
export const TOM_KEYS: Readonly<Record<number, number>> = { 41: -7, 43: -4, 45: 0, 47: 3, 48: 5, 50: 8 };
