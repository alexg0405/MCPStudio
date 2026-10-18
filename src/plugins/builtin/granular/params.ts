import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const GRANULAR_ID = 'agstudio.granular';

/** The built-in sounds the instrument plays while its sample slot is empty (made in `textures.kernel.ts`). */
export const TEXTURE_OPTIONS = [
  ['choir', 'Choir (a sung "ah" chord)'],
  ['glass', 'Glass bells'],
  ['strings', 'String ensemble'],
  ['air', 'Airy noise'],
  ['pluck', 'Plucked arpeggio (rhythmic)'],
] as const;
export const TEXTURE_IDS = TEXTURE_OPTIONS.map(([id]) => id);

/** The shape of each grain's fade in and out: how the grain's volume moves from its start to its end. */
export const GRAIN_SHAPES = [
  ['hann', 'Smooth (Hann)', 'A soft bell: the smoothest cloud, no clicks'],
  ['gauss', 'Gaussian', 'A narrower bell: grains blend a little less, the middle of each stands out'],
  ['triangle', 'Triangle', 'Straight ramps up and down: a little more edge than Smooth'],
  ['flat', 'Flat top', 'Short fades with a steady middle: grains sound like the sample itself, in pieces'],
  ['pluck', 'Percussive', 'A very quick start and a long exponential fall: each grain is a tiny hit (glitchy, rhythmic)'],
  ['swell', 'Reverse swell', 'A long rise and a sudden end: each grain sucks in (reverse-cymbal feel)'],
] as const;

/** Scan lengths when the scan is locked to the song: how many beats one pass through the whole sample lasts. */
export const SCAN_LENGTHS = [
  ['1/4', 1, '1 beat'],
  ['1/2', 2, '2 beats'],
  ['1bar', 4, '1 bar'],
  ['2bars', 8, '2 bars'],
  ['4bars', 16, '4 bars'],
  ['8bars', 32, '8 bars'],
] as const;

export const FILTER_KINDS = [
  ['off', 'Off'],
  ['lp', 'Low-pass (darker)'],
  ['hp', 'High-pass (thinner)'],
] as const;

export const MAX_VOICES = 8;

export const granularParams = {
  texture: p.enum(
    TEXTURE_IDS,
    'choir',
    {
      label: 'Built-in sound',
      labels: Object.fromEntries(TEXTURE_OPTIONS),
      group: 'Source',
      hint: 'What the grains are cut from while no sample is loaded (drop a sample on the editor to use your own)',
      automatable: false,
    },
  ),
  position: p.float(0, 1, 0.3, {
    label: 'Position',
    unit: '%',
    group: 'Grains',
    hint: 'Where in the sample the grains are taken from (0% = start, 100% = end)',
  }),
  spray: p.float(0, 1, 0.08, {
    label: 'Position spray',
    unit: '%',
    group: 'Grains',
    hint: 'How far each grain may wander from the position, as a share of the whole sample: 0% = always the same spot (frozen), high = a cloud of the whole sample',
  }),
  size: p.float(5, 500, 90, {
    label: 'Grain size',
    unit: 'ms',
    scale: 'log',
    group: 'Grains',
    hint: 'How long each grain lasts: tiny grains buzz and glitch, long ones keep the sample recognisable',
  }),
  density: p.float(1, 200, 24, {
    label: 'Density',
    unit: 'Hz',
    scale: 'log',
    group: 'Grains',
    hint: 'New grains per second, per note: more makes a thicker, smoother cloud, a few makes distinct stutters',
  }),
  jitter: p.float(0, 1, 0.3, {
    label: 'Timing randomness',
    unit: '%',
    group: 'Grains',
    hint: '0% = grains start at perfectly even intervals (rhythmic), 100% = scattered (a cloud)',
  }),
  shape: p.enum(
    GRAIN_SHAPES.map(([id]) => id),
    'hann',
    {
      label: 'Grain shape',
      labels: Object.fromEntries(GRAIN_SHAPES.map(([id, label]) => [id, label])),
      group: 'Grains',
      hint: 'The fade in and out of each grain',
      automatable: false,
    },
  ),
  reverse: p.float(0, 1, 0, {
    label: 'Reverse',
    unit: '%',
    group: 'Grains',
    hint: 'The chance that a grain plays backwards: 0% = never, 100% = always',
  }),
  pitch: p.float(-24, 24, 0, {
    label: 'Pitch',
    unit: 'st',
    group: 'Pitch',
    hint: 'Pitch of every grain in semitones, on top of the key you play',
  }),
  fine: p.float(-100, 100, 0, { label: 'Fine', unit: 'ct', group: 'Pitch', hint: 'Fine tuning in cents' }),
  pitchSpray: p.float(0, 12, 0, {
    label: 'Pitch spray',
    unit: 'st',
    group: 'Pitch',
    hint: 'Each grain is tuned up or down by a random amount up to this many semitones (small = shimmer, large = scatter)',
  }),
  keyTrack: p.float(0, 1, 1, {
    label: 'Key tracking',
    unit: '%',
    group: 'Pitch',
    hint: '100% = the sample is played at the pitch of the key (middle key C5 = original pitch). 0% = every key sounds the same pitch (a pure texture, the keys only start notes)',
  }),
  spread: p.float(0, 1, 0.6, {
    label: 'Stereo spread',
    unit: '%',
    group: 'Stereo',
    hint: 'Each grain lands somewhere random between left and right, up to this far from the centre',
  }),
  scan: p.float(-4, 4, 0, {
    label: 'Scan speed',
    unit: 'x',
    group: 'Scan',
    hint: 'Moves the position while a note plays: 1x = the sample\'s own speed (forwards), 0 = stays put, negative = backwards. Needs a sample longer than the grains',
  }),
  scanSync: p.bool(false, {
    label: 'Sync scan to tempo',
    group: 'Scan',
    hint: 'Sweep the position through the whole sample once per chosen length, locked to the song (the direction follows the sign of Scan speed)',
    automatable: false,
  }),
  scanLength: p.enum(
    SCAN_LENGTHS.map(([id]) => id),
    '2bars',
    {
      label: 'Scan length',
      labels: Object.fromEntries(SCAN_LENGTHS.map(([id, , label]) => [id, label])),
      group: 'Scan',
      hint: 'How long one pass through the sample takes when synced to the tempo',
      automatable: false,
    },
  ),
  freeze: p.bool(false, {
    label: 'Freeze',
    group: 'Scan',
    hint: 'Holds the scan where it is: the cloud keeps playing the same spot of the sample (turn it on while a scan passes something you like)',
    automatable: true,
  }),
  filterType: p.enum(
    FILTER_KINDS.map(([id]) => id),
    'lp',
    {
      label: 'Filter',
      labels: Object.fromEntries(FILTER_KINDS),
      group: 'Filter',
      hint: 'A filter after the grains of each note',
      automatable: false,
    },
  ),
  cutoff: p.float(20, 20000, 12000, {
    label: 'Cutoff',
    unit: 'Hz',
    scale: 'log',
    group: 'Filter',
    hint: 'Where the filter starts working: lower is darker (low-pass) or thinner (high-pass)',
  }),
  resonance: p.float(0, 1, 0.1, {
    label: 'Resonance',
    unit: '%',
    group: 'Filter',
    hint: 'Emphasis at the cutoff: more is sharper, whistlier',
  }),
  ampAttack: p.float(0.001, 10, 0.05, {
    label: 'Attack',
    unit: 's',
    scale: 'log',
    group: 'Amp envelope',
    hint: 'Time to fade in when a note starts',
  }),
  ampDecay: p.float(0.005, 10, 0.4, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    group: 'Amp envelope',
    hint: 'Time to fall to the sustain level',
  }),
  ampSustain: p.float(0, 1, 0.85, {
    label: 'Sustain',
    unit: '%',
    group: 'Amp envelope',
    hint: 'Level held while the key is down',
  }),
  ampRelease: p.float(0.005, 10, 0.5, {
    label: 'Release',
    unit: 's',
    scale: 'log',
    group: 'Amp envelope',
    hint: 'Time to fade out after the key is released',
  }),
  velocity: p.float(0, 1, 0.5, {
    label: 'Velocity',
    unit: '%',
    group: 'Amp envelope',
    hint: 'How much harder notes play louder (0% = every note the same)',
  }),
  voices: p.int(1, MAX_VOICES, MAX_VOICES, {
    label: 'Voices',
    group: 'Voice',
    hint: 'How many notes can sound at once (each note has its own cloud): fewer is lighter on the processor; the oldest note makes way',
    automatable: false,
  }),
  seed: p.int(0, 9999, 1, {
    label: 'Random seed',
    group: 'Voice',
    hint: 'The grains\' random choices are repeatable: the same seed gives the same cloud every time. Change it for a different one',
    automatable: false,
  }),
  level: p.float(-36, 6, -8, { label: 'Volume', unit: 'dB', scale: 'db', group: 'Voice', hint: 'Overall level' }),
};

export type GranularParams = typeof granularParams;

/** Grain slots whose position, progress and pan the kernel reports to the editor (the newest grains). */
export const TELEMETRY_GRAINS = 24;
/** Reading names of the telemetry: `gp<i>` = where in the sample (0–1, −1 when the slot is empty), `gq<i>` = how far through the grain (0–1), `gx<i>` = pan (−1…1). */
export const telemetryNames = (() => {
  const names: string[] = ['grains', 'voices'];
  for (let i = 0; i < TELEMETRY_GRAINS; i++) names.push(`gp${i}`, `gq${i}`, `gx${i}`);
  return names;
})();
