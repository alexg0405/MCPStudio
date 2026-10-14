import { p, type ParamSpec } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const WAVETABLE_ID = 'agstudio.wavetable';

/** The factory tables, in bank order (tables.ts builds them in the same order). */
export const TABLE_OPTIONS = [
  ['basic', 'Basic shapes'],
  ['pulse', 'Pulse width'],
  ['sync', 'Sync sweep'],
  ['harmonics', 'Harmonic series'],
  ['vocal', 'Vocal'],
  ['formant', 'Formant sweep'],
  ['organ', 'Organ'],
  ['glass', 'Glass'],
  ['resonant', 'Resonant sweep'],
  ['grit', 'Digital grit'],
] as const;
const TABLE_IDS = TABLE_OPTIONS.map(([id]) => id);
const TABLE_LABELS = Object.fromEntries(TABLE_OPTIONS) as Record<(typeof TABLE_IDS)[number], string>;

export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'ramp', 'square', 'random', 'smooth'] as const;
const LFO_SHAPE_LABELS = {
  sine: 'Sine',
  triangle: 'Triangle',
  saw: 'Saw (rising)',
  ramp: 'Ramp (falling)',
  square: 'Square',
  random: 'Random steps',
  smooth: 'Smooth random',
};

/** Synced LFO lengths and how many beats (quarter notes) each lasts; a bar is 4 beats. */
export const LFO_LENGTHS = [
  ['1/32', 0.125, '1/32 note'],
  ['1/16T', 1 / 6, '1/16 triplet'],
  ['1/16', 0.25, '1/16 note'],
  ['1/16.', 0.375, 'Dotted 1/16'],
  ['1/8T', 1 / 3, '1/8 triplet'],
  ['1/8', 0.5, '1/8 note'],
  ['1/8.', 0.75, 'Dotted 1/8'],
  ['1/4T', 2 / 3, '1/4 triplet'],
  ['1/4', 1, '1/4 note (a beat)'],
  ['1/4.', 1.5, 'Dotted 1/4'],
  ['1/2', 2, '1/2 note'],
  ['1bar', 4, '1 bar'],
  ['2bars', 8, '2 bars'],
  ['4bars', 16, '4 bars'],
] as const;
export const LFO_BEATS = LFO_LENGTHS.map(([, beats]) => beats) as readonly number[];

export const MOD_SOURCES = ['none', 'modEnv', 'lfo1', 'lfo2', 'velocity', 'modWheel', 'keyTrack'] as const;
const MOD_SOURCE_LABELS = {
  none: 'Off',
  modEnv: 'Mod envelope',
  lfo1: 'LFO 1',
  lfo2: 'LFO 2',
  velocity: 'Velocity',
  modWheel: 'Mod wheel',
  keyTrack: 'Key (note pitch)',
};
export const MOD_TARGETS = [
  'pitch',
  'osc1Position',
  'osc2Position',
  'cutoff',
  'resonance',
  'amp',
  'pan',
  'lfo1Rate',
  'lfo2Rate',
] as const;
const MOD_TARGET_LABELS = {
  pitch: 'Pitch (100% = 2 octaves)',
  osc1Position: 'Osc 1 position',
  osc2Position: 'Osc 2 position',
  cutoff: 'Filter cutoff (100% = 8 octaves)',
  resonance: 'Filter resonance',
  amp: 'Volume',
  pan: 'Pan',
  lfo1Rate: 'LFO 1 speed (100% = 4 octaves)',
  lfo2Rate: 'LFO 2 speed (100% = 4 octaves)',
};
export const MOD_SLOTS = 6;

export const FILTER_TYPES = ['lp12', 'lp24', 'hp', 'bp', 'notch'] as const;

/** Param ids of oscillator `n` (1–2). */
export const oscParam = (n: number) =>
  ({
    table: `osc${n}Table`,
    position: `osc${n}Position`,
    coarse: `osc${n}Coarse`,
    fine: `osc${n}Fine`,
    level: `osc${n}Level`,
    pan: `osc${n}Pan`,
  }) as const;

/** Param ids of LFO `n` (1–2). */
export const lfoParam = (n: number) =>
  ({
    shape: `lfo${n}Shape`,
    sync: `lfo${n}Sync`,
    rate: `lfo${n}Rate`,
    length: `lfo${n}Length`,
    retrigger: `lfo${n}Retrigger`,
  }) as const;

/** Param ids of mod matrix slot `n` (1–6). */
export const modParam = (n: number) =>
  ({ source: `mod${n}Source`, target: `mod${n}Target`, amount: `mod${n}Amount` }) as const;

function osc(n: number, d: { table: (typeof TABLE_IDS)[number]; position: number; level: number }) {
  const id = oscParam(n);
  const group = `Oscillator ${n}`;
  return {
    [id.table]: p.enum(TABLE_IDS, d.table, {
      label: `Osc ${n} table`,
      labels: TABLE_LABELS,
      group,
      hint: 'The family of shapes the oscillator morphs through',
    }),
    [id.position]: p.float(0, 1, d.position, {
      label: `Osc ${n} position`,
      unit: '%',
      group,
      hint: 'Where in the table: morphs smoothly through its shapes (modulate it for movement)',
    }),
    [id.coarse]: p.int(-24, 24, 0, { label: `Osc ${n} coarse`, unit: 'st', group, hint: 'Tuning in semitones' }),
    [id.fine]: p.float(-100, 100, 0, { label: `Osc ${n} fine`, unit: 'ct', group, hint: 'Fine tuning in cents' }),
    [id.level]: p.float(0, 1, d.level, {
      label: `Osc ${n} level`,
      unit: '%',
      group,
      hint: 'How loud the oscillator is (0% turns it off)',
    }),
    [id.pan]: p.float(-1, 1, 0, { label: `Osc ${n} pan`, group, hint: 'Left (−1) to right (+1)' }),
  } as Record<string, ParamSpec>;
}

function lfo(
  n: number,
  d: { shape: (typeof LFO_SHAPES)[number]; rate: number; length: (typeof LFO_LENGTHS)[number][0] },
) {
  const id = lfoParam(n);
  const group = `LFO ${n}`;
  return {
    [id.shape]: p.enum(LFO_SHAPES, d.shape, {
      label: `LFO ${n} shape`,
      labels: LFO_SHAPE_LABELS,
      group,
      hint: 'How the LFO moves',
    }),
    [id.sync]: p.bool(false, {
      label: `LFO ${n} sync`,
      group,
      hint: 'Lock the LFO to the song’s tempo: it then lasts the chosen note length and lands on the beat',
    }),
    [id.rate]: p.float(0.02, 40, d.rate, {
      label: `LFO ${n} speed`,
      unit: 'Hz',
      scale: 'log',
      group,
      hint: 'Cycles per second (when not synced to the tempo)',
    }),
    [id.length]: p.enum(
      LFO_LENGTHS.map(([lid]) => lid),
      d.length,
      {
        label: `LFO ${n} length`,
        labels: Object.fromEntries(LFO_LENGTHS.map(([lid, , label]) => [lid, label])),
        group,
        hint: 'How long one cycle lasts when synced to the tempo',
      },
    ),
    [id.retrigger]: p.bool(true, {
      label: `LFO ${n} restart`,
      group,
      hint: 'Start the LFO from the beginning on every note (off: it keeps running)',
    }),
  } as Record<string, ParamSpec>;
}

const MOD_DEFAULT_TARGETS = ['cutoff', 'pitch', 'osc1Position', 'amp', 'pan', 'osc2Position'] as const;

function slot(n: number) {
  const id = modParam(n);
  const group = 'Mod matrix';
  const target = MOD_DEFAULT_TARGETS[n - 1] ?? 'cutoff';
  return {
    [id.source]: p.enum(MOD_SOURCES, 'none', {
      label: `Mod ${n} source`,
      labels: MOD_SOURCE_LABELS,
      group,
      hint: 'What moves the destination',
    }),
    [id.target]: p.enum(MOD_TARGETS, target, {
      label: `Mod ${n} destination`,
      labels: MOD_TARGET_LABELS,
      group,
      hint: 'What gets moved',
    }),
    [id.amount]: p.float(-1, 1, target === 'pitch' ? 0.02 : 0.3, {
      label: `Mod ${n} amount`,
      unit: '%',
      group,
      hint: 'How much, and which way (negative turns it around)',
    }),
  } as Record<string, ParamSpec>;
}

const envTime = (label: string, def: number, group: string, hint: string, min = 0.001) =>
  p.float(min, 10, def, { label, unit: 's', scale: 'log', group, hint });

export const wavetableParams: Record<string, ParamSpec> = {
  ...osc(1, { table: 'basic', position: 2 / 3, level: 0.8 }),
  ...osc(2, { table: 'basic', position: 1, level: 0 }),
  unison: p.int(1, 8, 1, {
    label: 'Unison voices',
    group: 'Unison',
    hint: 'Copies of each oscillator per note, detuned and spread: 1 = off, 4–8 = big supersaw',
  }),
  detune: p.float(0, 100, 18, {
    label: 'Unison detune',
    unit: 'ct',
    group: 'Unison',
    hint: 'How far apart the unison copies are tuned',
  }),
  spread: p.float(0, 1, 0.7, {
    label: 'Unison spread',
    unit: '%',
    group: 'Unison',
    hint: 'How wide the unison copies spread across the stereo field',
  }),
  subLevel: p.float(0, 1, 0, {
    label: 'Sub level',
    unit: '%',
    group: 'Sub & noise',
    hint: 'A sub oscillator below the note',
  }),
  subShape: p.enum(['sine', 'triangle', 'square'], 'sine', {
    label: 'Sub shape',
    labels: { sine: 'Sine', triangle: 'Triangle', square: 'Square' },
    group: 'Sub & noise',
    hint: 'The sub oscillator’s wave',
  }),
  subOctave: p.enum(['1', '2'], '1', {
    label: 'Sub octave',
    labels: { '1': '1 octave down', '2': '2 octaves down' },
    group: 'Sub & noise',
    hint: 'How far below the note the sub plays',
  }),
  noiseLevel: p.float(0, 1, 0, {
    label: 'Noise level',
    unit: '%',
    group: 'Sub & noise',
    hint: 'Adds noise (breath, air, hiss)',
  }),
  noiseTone: p.float(0, 1, 0.7, {
    label: 'Noise tone',
    unit: '%',
    group: 'Sub & noise',
    hint: 'Darker (rumble) to brighter (hiss)',
  }),
  filterType: p.enum(FILTER_TYPES, 'lp12', {
    label: 'Filter type',
    labels: {
      lp12: 'Low-pass 12 dB',
      lp24: 'Low-pass 24 dB (steeper)',
      hp: 'High-pass',
      bp: 'Band-pass',
      notch: 'Notch',
    },
    group: 'Filter',
    hint: 'Low-pass keeps the lows, high-pass the highs, band-pass a band around the cutoff, notch removes one',
  }),
  cutoff: p.float(20, 20000, 12000, {
    label: 'Cutoff',
    unit: 'Hz',
    scale: 'log',
    group: 'Filter',
    hint: 'Where the filter starts working: lower is darker (for low-pass)',
  }),
  resonance: p.float(0, 1, 0.1, {
    label: 'Resonance',
    unit: '%',
    group: 'Filter',
    hint: 'Emphasis at the cutoff: more is sharper, whistlier',
  }),
  drive: p.float(0, 1, 0, {
    label: 'Drive',
    unit: '%',
    group: 'Filter',
    hint: 'Saturation before the filter: warmer, grittier',
  }),
  keyTrack: p.float(0, 1, 0.3, {
    label: 'Key tracking',
    unit: '%',
    group: 'Filter',
    hint: 'How much the cutoff follows the notes you play (100% = exactly, so high notes stay as bright)',
  }),
  envAmount: p.float(-1, 1, 0, {
    label: 'Envelope amount',
    unit: '%',
    group: 'Filter',
    hint: 'How far the mod envelope moves the cutoff on each note (100% = 8 octaves up; negative = down)',
  }),
  ampAttack: envTime('Attack', 0.003, 'Amp envelope', 'Time to fade in when a note starts'),
  ampDecay: envTime('Decay', 0.4, 'Amp envelope', 'Time to fall to the sustain level'),
  ampSustain: p.float(0, 1, 0.8, {
    label: 'Sustain',
    unit: '%',
    group: 'Amp envelope',
    hint: 'Level held while the key is down',
  }),
  ampRelease: envTime('Release', 0.25, 'Amp envelope', 'Time to fade out after the key is released', 0.005),
  velocity: p.float(0, 1, 0.7, {
    label: 'Velocity',
    unit: '%',
    group: 'Amp envelope',
    hint: 'How much harder notes play louder (0% = every note the same)',
  }),
  modAttack: envTime('Mod attack', 0.003, 'Mod envelope', 'Time for the mod envelope to rise when a note starts'),
  modDecay: envTime('Mod decay', 0.5, 'Mod envelope', 'Time to fall to its sustain level'),
  modSustain: p.float(0, 1, 0, {
    label: 'Mod sustain',
    unit: '%',
    group: 'Mod envelope',
    hint: 'Level held while the key is down',
  }),
  modRelease: envTime('Mod release', 0.3, 'Mod envelope', 'Time to fall to zero after the key is released', 0.005),
  ...lfo(1, { shape: 'sine', rate: 2, length: '1/4' }),
  ...lfo(2, { shape: 'triangle', rate: 0.3, length: '1bar' }),
  ...Object.assign({}, ...Array.from({ length: MOD_SLOTS }, (_, i) => slot(i + 1))),
  voiceMode: p.enum(['poly', 'mono', 'legato'], 'poly', {
    label: 'Voice mode',
    labels: { poly: 'Poly (chords)', mono: 'Mono', legato: 'Legato (mono, slides)' },
    group: 'Voice',
    hint: 'Poly plays chords; mono plays one note at a time; legato also slides between overlapping notes without restarting',
  }),
  glide: p.float(0, 1, 0, {
    label: 'Glide',
    unit: 's',
    group: 'Voice',
    hint: 'Time to slide from the previous note’s pitch to the new one (0 = off)',
  }),
  level: p.float(-36, 6, -8, { label: 'Volume', unit: 'dB', scale: 'db', group: 'Voice', hint: 'Overall level' }),
};
