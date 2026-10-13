/**
 * The piano roll's built-in tools, written as note scripts against the public SDK (exactly what a
 * user script in plugins/ can do). Each one is a thin wrapper around `@agstudio/sdk/notes`.
 */
import { defineNoteScript, p, type NoteScriptContext, type ParamSpecs, type ScriptNote } from '@agstudio/sdk';
import {
  ARP_PATTERNS,
  arpeggiate,
  CHORDS,
  chop,
  chordify,
  diatonicChord,
  fitVelocities,
  flip,
  generate,
  glue,
  humanize,
  legato,
  limit,
  PITCH_NAMES,
  quantize,
  rampVelocities,
  randomize,
  scaleVelocities,
  SCALES,
  snapNotesToScale,
  span,
  stretch,
  strum,
  transpose,
  transposeDegrees,
  transposeInScale,
  VOICINGS,
  type KeyLike,
} from '@agstudio/sdk/notes';

// ---------------------------------------------------------------------------------------------
// Shared params

/** Note values in quarter notes. */
const NOTE_VALUES = {
  '1/64': 1 / 16,
  '1/32': 1 / 8,
  '1/16': 1 / 4,
  '1/8': 1 / 2,
  '1/4': 1,
  '1/2': 2,
  '1/32t': 1 / 12,
  '1/16t': 1 / 6,
  '1/8t': 1 / 3,
  '1/4t': 2 / 3,
} as const;
type NoteValue = keyof typeof NOTE_VALUES;
const VALUE_IDS = Object.keys(NOTE_VALUES) as NoteValue[];

const gridParam = (def: 'snap' | NoteValue | 'bar', label = 'Grid') =>
  p.enum(['snap', ...VALUE_IDS, 'bar'], def, {
    label,
    labels: {
      snap: 'Snap',
      bar: '1 bar',
      '1/32t': '1/32 triplet',
      '1/16t': '1/16 triplet',
      '1/8t': '1/8 triplet',
      '1/4t': '1/4 triplet',
    },
    hint: '"Snap" follows the piano roll\'s snap setting',
  });

/** Ticks for a grid param value. */
function ticks(value: string, ctx: NoteScriptContext<ParamSpecs>): number {
  if (value === 'snap') return ctx.grid > 1 ? ctx.grid : ctx.ppq / 4;
  if (value === 'bar') return ctx.bar;
  return Math.max(1, Math.round(ctx.ppq * (NOTE_VALUES[value as NoteValue] ?? 0.25)));
}

const seedParam = () => p.int(1, 999, 1, { label: 'Seed', hint: 'Change it for a different random result' });

/** The song's key, or C major when none is set. */
const keyOf = (ctx: NoteScriptContext<ParamSpecs>): KeyLike => ctx.key ?? { root: 0, scale: 'major' };

const ROOTS = ['song', ...PITCH_NAMES] as const;
const rootParam = () => p.enum(ROOTS, 'song', { label: 'Root', labels: { song: 'Song key' } });
const scaleParam = () =>
  p.enum(['song', ...SCALES.map((s) => s.id)], 'song', {
    label: 'Scale',
    labels: { song: 'Song key', ...Object.fromEntries(SCALES.map((s) => [s.id, s.label])) },
  });

/** A key from root/scale params that default to the song's key. */
function chosenKey(ctx: NoteScriptContext<ParamSpecs>, root: string, scale: string): KeyLike {
  const song = keyOf(ctx);
  return {
    root: root === 'song' ? song.root : PITCH_NAMES.indexOf(root as (typeof PITCH_NAMES)[number]),
    scale: scale === 'song' ? song.scale : scale,
  };
}

/** Where generated notes go: the bars the notes cover, or the whole pattern when there are none. */
function bars(ctx: NoteScriptContext<ParamSpecs>): { start: number; end: number } {
  const s = span(ctx.notes);
  if (!s) return { start: 0, end: ctx.length };
  return { start: Math.floor(s.start / ctx.bar) * ctx.bar, end: Math.ceil(s.end / ctx.bar) * ctx.bar };
}

// ---------------------------------------------------------------------------------------------
// Timing

const quantizeTool = defineNoteScript({
  id: 'agstudio.notes.quantize',
  name: 'Quantize',
  version: 1,
  category: 'Timing',
  description: 'Moves note starts (and optionally ends) towards the grid.',
  params: {
    grid: gridParam('snap'),
    strength: p.float(0, 1, 1, { label: 'Strength', unit: '%' }),
    starts: p.bool(true, { label: 'Start times' }),
    ends: p.enum(['keep', 'snap', 'lengths'], 'keep', {
      label: 'Ends',
      labels: { keep: 'Keep lengths', snap: 'Snap ends', lengths: 'Round lengths' },
    }),
    swing: p.float(0, 1, 0, { label: 'Swing', unit: '%' }),
    window: p.float(0.05, 1, 1, { label: 'Window', unit: '%', hint: 'Only notes this close to a grid line move' }),
  },
  run: (ctx) =>
    quantize(ctx.notes, {
      grid: ticks(ctx.values.grid, ctx),
      strength: ctx.values.strength,
      starts: ctx.values.starts,
      ends: ctx.values.ends === 'snap',
      lengths: ctx.values.ends === 'lengths',
      swing: ctx.values.swing,
      window: ctx.values.window,
    }),
});

const humanizeTool = defineNoteScript({
  id: 'agstudio.notes.humanize',
  name: 'Humanize',
  version: 1,
  category: 'Timing',
  description: 'Small random changes in timing, velocity and length.',
  params: {
    timing: p.int(0, 240, 20, { label: 'Timing ± (ticks)', hint: '960 ticks = one beat' }),
    velocity: p.float(0, 0.5, 0.1, { label: 'Velocity ±', unit: '%' }),
    length: p.float(0, 0.5, 0, { label: 'Length ±', unit: '%' }),
    seed: seedParam(),
  },
  run: (ctx) =>
    humanize(ctx.notes, {
      rand: ctx.rand,
      timing: ctx.values.timing,
      velocity: ctx.values.velocity,
      length: ctx.values.length,
    }),
});

const legatoTool = defineNoteScript({
  id: 'agstudio.notes.legato',
  name: 'Legato',
  version: 1,
  category: 'Timing',
  description: 'Every note lasts until the next one starts.',
  params: {
    gap: p.int(0, 240, 0, { label: 'Gap (ticks)' }),
    last: p.enum(['keep', 'pattern'], 'keep', {
      label: 'Last notes',
      labels: { keep: 'Keep length', pattern: 'Until the pattern end' },
    }),
  },
  run: (ctx) =>
    legato(ctx.notes, { gap: ctx.values.gap, ...(ctx.values.last === 'pattern' ? { until: ctx.length } : {}) }),
});

const strumTool = defineNoteScript({
  id: 'agstudio.notes.strum',
  name: 'Strum',
  version: 1,
  category: 'Timing',
  description: 'Spreads the notes of each chord out in time.',
  params: {
    time: p.float(0, 1, 0.125, { label: 'Time', unit: 'beats' }),
    direction: p.enum(['up', 'down', 'alternate', 'random'], 'up', { label: 'Direction' }),
    curve: p.float(-1, 1, 0, { label: 'Curve' }),
    velocity: p.float(-1, 1, 0, { label: 'Velocity fade', unit: '%' }),
    tolerance: p.int(0, 240, 20, {
      label: 'Chord window (ticks)',
      hint: 'Notes this close together count as one chord',
    }),
    keepEnds: p.bool(true, { label: 'Keep ends' }),
    seed: seedParam(),
  },
  run: (ctx) =>
    strum(ctx.notes, {
      time: ctx.values.time * ctx.ppq,
      direction: ctx.values.direction,
      curve: ctx.values.curve,
      velocity: ctx.values.velocity,
      tolerance: ctx.values.tolerance,
      keepEnds: ctx.values.keepEnds,
      rand: ctx.rand,
    }),
});

const stretchTool = defineNoteScript({
  id: 'agstudio.notes.stretch',
  name: 'Stretch',
  version: 1,
  category: 'Timing',
  description: 'Scales the notes in time (2× = half time).',
  params: { factor: p.float(0.25, 4, 2, { label: 'Factor', unit: 'x', scale: 'log' }) },
  run: (ctx) => stretch(ctx.notes, { factor: ctx.values.factor }),
});

// ---------------------------------------------------------------------------------------------
// Edit

const chopTool = defineNoteScript({
  id: 'agstudio.notes.chop',
  name: 'Chop',
  version: 1,
  category: 'Edit',
  description: 'Cuts notes into pieces on a grid or into equal parts.',
  params: {
    mode: p.enum(['grid', 'parts'], 'grid', { label: 'Cut', labels: { grid: 'On the grid', parts: 'Into parts' } }),
    grid: gridParam('1/16'),
    parts: p.int(2, 32, 4, { label: 'Parts' }),
    gate: p.float(0.05, 1, 1, { label: 'Gate', unit: '%' }),
  },
  run: (ctx) =>
    chop(
      ctx.notes,
      ctx.values.mode === 'grid'
        ? { grid: ticks(ctx.values.grid, ctx), gate: ctx.values.gate }
        : { parts: ctx.values.parts, gate: ctx.values.gate },
    ),
});

const glueTool = defineNoteScript({
  id: 'agstudio.notes.glue',
  name: 'Glue',
  version: 1,
  category: 'Edit',
  description: 'Joins same-key notes that touch (or nearly touch) into one.',
  params: { gap: p.int(0, 960, 0, { label: 'Max gap (ticks)' }) },
  run: (ctx) => glue(ctx.notes, { gap: ctx.values.gap }),
});

const flipTool = defineNoteScript({
  id: 'agstudio.notes.flip',
  name: 'Flip',
  version: 1,
  category: 'Edit',
  description: 'Mirrors the notes in time (reverse) or in pitch (upside down).',
  params: {
    axis: p.enum(['time', 'pitch'], 'time', { label: 'Flip', labels: { time: 'In time', pitch: 'In pitch' } }),
  },
  run: (ctx) => flip(ctx.notes, ctx.values.axis),
});

const lengthTool = defineNoteScript({
  id: 'agstudio.notes.length',
  name: 'Set length',
  version: 1,
  category: 'Edit',
  description: 'Gives every note the same length.',
  params: { length: gridParam('1/16', 'Length') },
  run: (ctx) => {
    const length = ticks(ctx.values.length, ctx);
    return ctx.notes.map((n) => ({ ...n, length }));
  },
});

const limitTool = defineNoteScript({
  id: 'agstudio.notes.limit',
  name: 'Limit range',
  version: 1,
  category: 'Edit',
  description: 'Moves notes outside a key range into it by octaves.',
  params: {
    low: p.int(0, 127, 48, { label: 'Lowest key', hint: '60 = C5' }),
    high: p.int(0, 127, 72, { label: 'Highest key', hint: '60 = C5' }),
  },
  run: (ctx) => limit(ctx.notes, { low: ctx.values.low, high: ctx.values.high }),
});

// ---------------------------------------------------------------------------------------------
// Pitch

const transposeTool = defineNoteScript({
  id: 'agstudio.notes.transpose',
  name: 'Transpose',
  version: 1,
  category: 'Pitch',
  description: 'Moves notes by scale steps in the song key and by semitones.',
  params: {
    steps: p.int(-14, 14, 0, { label: 'Scale steps', hint: 'Steps of the song key (C major when none is set)' }),
    semitones: p.int(-48, 48, 0, { label: 'Semitones', unit: 'st' }),
  },
  run: (ctx) => transpose(transposeDegrees(ctx.notes, ctx.values.steps, keyOf(ctx)), ctx.values.semitones),
});

const snapTool = defineNoteScript({
  id: 'agstudio.notes.snap-to-scale',
  name: 'Snap to scale',
  version: 1,
  category: 'Pitch',
  description: 'Moves notes onto the nearest key of a scale.',
  params: {
    root: rootParam(),
    scale: scaleParam(),
    direction: p.enum(['nearest', 'up', 'down'], 'nearest', { label: 'Direction' }),
  },
  run: (ctx) => snapNotesToScale(ctx.notes, chosenKey(ctx, ctx.values.root, ctx.values.scale), ctx.values.direction),
});

const chordsTool = defineNoteScript({
  id: 'agstudio.notes.chords',
  name: 'Make chords',
  version: 1,
  category: 'Pitch',
  description: 'Turns every note into a chord built on it.',
  params: {
    chord: p.enum(['diatonic', 'diatonic7', ...CHORDS.map((c) => c.id)], 'diatonic', {
      label: 'Chord',
      labels: {
        diatonic: 'In key: triads',
        diatonic7: 'In key: 7ths',
        ...Object.fromEntries(CHORDS.map((c) => [c.id, c.label])),
      },
    }),
    inversion: p.int(-3, 3, 0, { label: 'Inversion' }),
    voicing: p.enum(VOICINGS, 'close', { label: 'Voicing' }),
  },
  run: (ctx) => {
    const diatonic = ctx.values.chord === 'diatonic' || ctx.values.chord === 'diatonic7';
    return chordify(ctx.notes, {
      chord: diatonic ? 'diatonic' : ctx.values.chord,
      size: ctx.values.chord === 'diatonic7' ? 4 : 3,
      inversion: ctx.values.inversion,
      voicing: ctx.values.voicing,
      key: keyOf(ctx),
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Velocity

const scaleVelocityTool = defineNoteScript({
  id: 'agstudio.notes.velocity-scale',
  name: 'Scale velocities',
  version: 1,
  category: 'Velocity',
  description: 'Multiplies velocities and adds an offset.',
  params: {
    factor: p.float(0, 2, 1, { label: 'Amount', unit: 'x' }),
    offset: p.float(-1, 1, 0, { label: 'Offset', unit: '%' }),
  },
  run: (ctx) => scaleVelocities(ctx.notes, { factor: ctx.values.factor, offset: ctx.values.offset }),
});

const velocityRangeTool = defineNoteScript({
  id: 'agstudio.notes.velocity-range',
  name: 'Velocity range',
  version: 1,
  category: 'Velocity',
  description: 'Maps the softest note to the minimum and the loudest to the maximum.',
  params: {
    min: p.float(0, 1, 0.4, { label: 'Minimum', unit: '%' }),
    max: p.float(0, 1, 1, { label: 'Maximum', unit: '%' }),
  },
  run: (ctx) => fitVelocities(ctx.notes, { min: ctx.values.min, max: ctx.values.max }),
});

const velocityRampTool = defineNoteScript({
  id: 'agstudio.notes.velocity-ramp',
  name: 'Velocity ramp',
  version: 1,
  category: 'Velocity',
  description: 'A crescendo or decrescendo across the notes.',
  params: {
    from: p.float(0, 1, 0.3, { label: 'From', unit: '%' }),
    to: p.float(0, 1, 1, { label: 'To', unit: '%' }),
    curve: p.float(-1, 1, 0, { label: 'Curve' }),
    multiply: p.bool(false, { label: 'Scale existing' }),
  },
  run: (ctx) =>
    rampVelocities(ctx.notes, {
      from: ctx.values.from,
      to: ctx.values.to,
      curve: ctx.values.curve,
      multiply: ctx.values.multiply,
    }),
});

// ---------------------------------------------------------------------------------------------
// Generate

const arpTool = defineNoteScript({
  id: 'agstudio.notes.arpeggiate',
  name: 'Arpeggiate',
  version: 1,
  category: 'Generate',
  description: 'Plays chords as arpeggios.',
  params: {
    pattern: p.enum(ARP_PATTERNS, 'up', {
      label: 'Pattern',
      labels: {
        'up-down': 'Up and down',
        'down-up': 'Down and up',
        'as-played': 'As played',
      },
    }),
    rate: gridParam('1/16', 'Rate'),
    gate: p.float(0.05, 1, 0.9, { label: 'Gate', unit: '%' }),
    octaves: p.int(1, 4, 1, { label: 'Octaves' }),
    range: p.int(0, 48, 0, {
      label: 'Range',
      unit: 'st',
      hint: 'Highest interval above the lowest note (0 = no limit)',
    }),
    seed: seedParam(),
  },
  run: (ctx) =>
    arpeggiate(ctx.notes, {
      rate: ticks(ctx.values.rate, ctx),
      gate: ctx.values.gate,
      pattern: ctx.values.pattern,
      octaves: ctx.values.octaves,
      range: ctx.values.range,
      rand: ctx.rand,
    }),
});

const randomizeTool = defineNoteScript({
  id: 'agstudio.notes.randomize',
  name: 'Randomize',
  version: 1,
  category: 'Generate',
  description: 'Random pitch and velocity changes, staying in the song key.',
  params: {
    pitch: p.int(0, 24, 5, { label: 'Pitch ±', unit: 'st' }),
    velocity: p.float(0, 0.5, 0.15, { label: 'Velocity ±', unit: '%' }),
    inKey: p.bool(true, { label: 'Stay in key' }),
    seed: seedParam(),
  },
  run: (ctx) =>
    randomize(ctx.notes, {
      rand: ctx.rand,
      pitch: ctx.values.pitch,
      velocity: ctx.values.velocity,
      key: ctx.values.inKey ? keyOf(ctx) : null,
    }),
});

const generateTool = defineNoteScript({
  id: 'agstudio.notes.generate',
  name: 'Generate melody',
  version: 1,
  category: 'Generate',
  description: 'Writes random notes in the song key over the bars the notes cover (or the whole pattern).',
  params: {
    density: p.float(0, 1, 0.5, { label: 'Density', unit: '%' }),
    rhythm: gridParam('1/8', 'Rhythm'),
    low: p.int(0, 127, 60, { label: 'Lowest key', hint: '60 = C5' }),
    range: p.int(0, 48, 12, { label: 'Range', unit: 'st' }),
    minLength: p.int(1, 8, 1, { label: 'Shortest (cells)' }),
    maxLength: p.int(1, 8, 2, { label: 'Longest (cells)' }),
    smoothness: p.float(0, 1, 0.6, { label: 'Smoothness', unit: '%' }),
    chords: p.int(1, 4, 1, { label: 'Notes at once' }),
    replace: p.bool(true, { label: 'Replace notes' }),
    seed: seedParam(),
  },
  run: (ctx) => {
    const { start, end } = bars(ctx);
    const notes = generate({
      rand: ctx.rand,
      start,
      end,
      grid: ticks(ctx.values.rhythm, ctx),
      density: ctx.values.density,
      low: ctx.values.low,
      high: ctx.values.low + ctx.values.range,
      minLength: ctx.values.minLength,
      maxLength: ctx.values.maxLength,
      smoothness: ctx.values.smoothness,
      polyphony: ctx.values.chords,
      key: keyOf(ctx),
    });
    return ctx.values.replace ? notes : [...ctx.notes, ...notes];
  },
});

const PROGRESSIONS = {
  'I-V-vi-IV': [0, 4, 5, 3],
  'vi-IV-I-V': [5, 3, 0, 4],
  'I-vi-IV-V': [0, 5, 3, 4],
  'I-IV-V-IV': [0, 3, 4, 3],
  'ii-V-I-I': [1, 4, 0, 0],
  'i-VI-III-VII': [0, 5, 2, 6],
  'i-iv-v-i': [0, 3, 4, 0],
  'i-VII-VI-VII': [0, 6, 5, 6],
  'i-iv-VI-V': [0, 3, 5, 4],
} as const;
type Progression = keyof typeof PROGRESSIONS;

const progressionTool = defineNoteScript({
  id: 'agstudio.notes.progression',
  name: 'Chord progression',
  version: 1,
  category: 'Generate',
  description: 'Writes a chord progression in the song key.',
  params: {
    progression: p.enum(Object.keys(PROGRESSIONS) as Progression[], 'I-V-vi-IV', {
      label: 'Progression',
      labels: Object.fromEntries(Object.keys(PROGRESSIONS).map((k) => [k, k.replaceAll('-', ' – ')])),
    }),
    bars: p.enum(['0.5', '1', '2'], '1', { label: 'Bars per chord' }),
    size: p.enum(['3', '4', '5'], '3', { label: 'Notes', labels: { '3': 'Triads', '4': '7ths', '5': '9ths' } }),
    octave: p.int(2, 7, 5, { label: 'Octave', hint: 'Octave of the key root (5 = around C5)' }),
    inversion: p.int(-2, 3, 0, { label: 'Inversion' }),
    voicing: p.enum(VOICINGS, 'close', { label: 'Voicing' }),
    velocity: p.float(0.05, 1, 0.75, { label: 'Velocity', unit: '%' }),
    replace: p.bool(false, { label: 'Replace notes' }),
  },
  run: (ctx) => {
    const name = ctx.values.progression;
    // Without a song key, minor progressions (they start on "i") are written in C minor.
    const key = ctx.key ?? { root: 0, scale: name.startsWith('i-') ? 'minor' : 'major' };
    const chordLength = Math.round(ctx.bar * Number(ctx.values.bars));
    const start = bars(ctx).start;
    const tonic = key.root + 12 * ctx.values.octave;
    const out: ScriptNote[] = ctx.values.replace ? [] : [...ctx.notes];
    PROGRESSIONS[name].forEach((degree, i) => {
      const chordRoot = transposeInScale(tonic, degree, key.root, key.scale);
      const keys = diatonicChord(chordRoot, key.root, key.scale, Number(ctx.values.size), {
        inversion: ctx.values.inversion,
        voicing: ctx.values.voicing,
      });
      for (const k of keys)
        out.push({ tick: start + i * chordLength, length: chordLength, key: k, velocity: ctx.values.velocity });
    });
    return out;
  },
});

export default [
  quantizeTool,
  humanizeTool,
  legatoTool,
  strumTool,
  stretchTool,
  chopTool,
  glueTool,
  flipTool,
  lengthTool,
  limitTool,
  transposeTool,
  snapTool,
  chordsTool,
  scaleVelocityTool,
  velocityRangeTool,
  velocityRampTool,
  arpTool,
  randomizeTool,
  generateTool,
  progressionTool,
];
