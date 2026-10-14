import { p, type ParamSpec } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const FM_ID = 'agstudio.fm';

export const OPERATORS = 4;

/** The eight algorithms (the SDK's FM_ALGORITHMS, in the same order). */
export const ALGORITHMS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
const ALGORITHM_LABELS: Record<(typeof ALGORITHMS)[number], string> = {
  '1': '1: 4→3→2→1 (one stack)',
  '2': '2: (3+4)→2→1',
  '3': '3: (4 + 3→2)→1',
  '4': '4: (4→3 + 2)→1',
  '5': '5: 2→1 and 4→3 (two pairs)',
  '6': '6: 4→1, 2, 3 (one into three)',
  '7': '7: 4→3, plus 1 and 2',
  '8': '8: 1+2+3+4 (no modulation)',
};

/** Param ids of operator `n` (1–4). */
export const opParam = (n: number) =>
  ({
    ratio: `op${n}Ratio`,
    fine: `op${n}Fine`,
    level: `op${n}Level`,
    attack: `op${n}Attack`,
    decay: `op${n}Decay`,
    sustain: `op${n}Sustain`,
    release: `op${n}Release`,
    velocity: `op${n}Velocity`,
  }) as const;

/** Operator 1 is heard in every algorithm; 2–4 start as gentle modulators. */
const OP_DEFAULTS = [
  { level: 0.8, decay: 1.2, sustain: 0.7 },
  { level: 0.45, decay: 0.6, sustain: 0.4 },
  { level: 0, decay: 0.6, sustain: 0.4 },
  { level: 0, decay: 0.6, sustain: 0.4 },
] as const;

function opSpecs(n: number): Record<string, ParamSpec> {
  const id = opParam(n);
  const d = OP_DEFAULTS[n - 1] ?? OP_DEFAULTS[3];
  const group = `Operator ${n}`;
  return {
    [id.ratio]: p.int(0, 16, 1, {
      label: `Op ${n} ratio`,
      group,
      hint: 'Frequency as a multiple of the note: 1 = the note, 2 = an octave up, 3 = an octave and a fifth, 0 = half',
    }),
    [id.fine]: p.float(0, 1, 0, {
      label: `Op ${n} fine`,
      unit: '%',
      group,
      hint: 'Raises the frequency by up to 100% of the ratio (ratio 1 + 41% = 1.41): odd values give bells and metal',
    }),
    [id.level]: p.float(0, 1, d.level, {
      label: `Op ${n} level`,
      unit: '%',
      group,
      hint: 'For an operator you hear: its loudness. For one that modulates: how much it brightens the one it feeds',
    }),
    [id.attack]: p.float(0.001, 5, 0.002, {
      label: `Op ${n} attack`,
      unit: 's',
      scale: 'log',
      group,
      hint: 'Time to reach full level when a note starts',
    }),
    [id.decay]: p.float(0.01, 10, d.decay, {
      label: `Op ${n} decay`,
      unit: 's',
      scale: 'log',
      group,
      hint: 'Time to fall to the sustain level',
    }),
    [id.sustain]: p.float(0, 1, d.sustain, {
      label: `Op ${n} sustain`,
      unit: '%',
      group,
      hint: 'Level held while the key is down',
    }),
    [id.release]: p.float(0.005, 10, 0.3, {
      label: `Op ${n} release`,
      unit: 's',
      scale: 'log',
      group,
      hint: 'Time to fade out after the key is released',
    }),
    [id.velocity]: p.float(0, 1, n === 1 ? 0.7 : 0.4, {
      label: `Op ${n} velocity`,
      unit: '%',
      group,
      hint: 'How much harder notes raise this operator (on a modulator: harder notes sound brighter)',
    }),
  };
}

const ops: Record<string, ParamSpec> = {};
for (let n = 1; n <= OPERATORS; n++) Object.assign(ops, opSpecs(n));

export const fmParams: Record<string, ParamSpec> = {
  algorithm: p.enum(ALGORITHMS, '1', {
    label: 'Algorithm',
    labels: ALGORITHM_LABELS,
    group: 'Algorithm',
    hint: 'How the four operators connect: an arrow means “modulates” (brightens); only the last operator of each chain is heard',
    automatable: false,
  }),
  feedback: p.float(0, 1, 0, {
    label: 'Feedback',
    unit: '%',
    group: 'Algorithm',
    hint: 'Operator 4 modulates itself: from a sine (0%) towards a buzzy saw (100%)',
  }),
  ...ops,
  cutoff: p.float(20, 20000, 20000, {
    label: 'Tone',
    unit: 'Hz',
    scale: 'log',
    group: 'Output',
    hint: 'A low-pass filter on the whole sound: turn down to soften it (all the way up is off)',
  }),
  resonance: p.float(0, 1, 0, {
    label: 'Resonance',
    unit: '%',
    group: 'Output',
    hint: 'Emphasis at the tone filter’s cutoff',
  }),
  vibratoDepth: p.float(0, 100, 0, {
    label: 'Vibrato',
    unit: 'ct',
    group: 'Output',
    hint: 'How far the pitch wobbles, in cents',
  }),
  vibratoRate: p.float(0.5, 12, 5.5, {
    label: 'Vibrato rate',
    unit: 'Hz',
    scale: 'log',
    group: 'Output',
    hint: 'How fast the pitch wobbles',
  }),
  wheel: p.enum(['brightness', 'vibrato', 'none'], 'brightness', {
    label: 'Mod wheel',
    labels: { brightness: 'Brighter', vibrato: 'More vibrato', none: 'Nothing' },
    group: 'Output',
    hint: 'What the MIDI mod wheel does: brightens the sound (modulators up to twice as strong) or adds up to 50 ct of vibrato',
  }),
  level: p.float(-36, 6, -8, { label: 'Volume', unit: 'dB', scale: 'db', group: 'Output', hint: 'Overall level' }),
};
