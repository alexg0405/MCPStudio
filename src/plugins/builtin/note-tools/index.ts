/**
 * The piano roll's built-in tools, written as note scripts against the public SDK (exactly what a
 * user script in plugins/ can do). Each one is a thin wrapper around `@agstudio/sdk/notes`.
 *
 * The descriptions are shown as the first line of each tool's dialog, so they say in plain words
 * what the tool does; param labels carry their units.
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
  noteName,
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

const VALUE_LABELS = {
  snap: 'Piano roll snap',
  bar: '1 bar',
  '1/64': '1/64 note',
  '1/32': '1/32 note',
  '1/16': '1/16 note (1 step)',
  '1/8': '1/8 note',
  '1/4': '1/4 note (1 beat)',
  '1/2': '1/2 note',
  '1/32t': '1/32 triplet',
  '1/16t': '1/16 triplet',
  '1/8t': '1/8 triplet',
  '1/4t': '1/4 triplet',
};

const gridParam = (def: 'snap' | NoteValue | 'bar', label = 'Grid', hint = 'The note value to use') =>
  p.enum(['snap', ...VALUE_IDS, 'bar'], def, { label, labels: VALUE_LABELS, hint });

/** Ticks for a grid param value ('0' = none). */
function ticks(value: string, ctx: NoteScriptContext<ParamSpecs>): number {
  if (value === '0') return 0;
  if (value === 'snap') return ctx.grid > 1 ? ctx.grid : ctx.ppq / 4;
  if (value === 'bar') return ctx.bar;
  return Math.max(1, Math.round(ctx.ppq * (NOTE_VALUES[value as NoteValue] ?? 0.25)));
}

/** A small time amount as a note value, with "none" first. */
const gapParam = (def: '0' | '1/64' | '1/32' | '1/16' | '1/8' | '1/4', label: string, none: string, hint: string) =>
  p.enum(['0', '1/64', '1/32', '1/16', '1/8', '1/4'], def, {
    label,
    labels: { ...VALUE_LABELS, '0': none },
    hint,
  });

/** A key as a note name ("C5" = 60, FL's octave numbering). */
const KEY_NAMES = Array.from({ length: 128 }, (_, k) => noteName(k));
const noteParam = (def: number, label: string, hint: string) =>
  p.enum(KEY_NAMES, KEY_NAMES[def] as string, { label, hint });
const keyOfName = (name: string) => Math.max(0, KEY_NAMES.indexOf(name));

const seedParam = () => p.int(1, 999, 1, { label: 'Seed', hint: 'Change the seed for a different random result' });

const voicingParam = () =>
  p.enum(VOICINGS, 'close', {
    label: 'Voicing',
    labels: {
      close: 'Close (stacked)',
      open: 'Open (spread out)',
      drop2: 'Drop 2',
      drop3: 'Drop 3',
      bass: 'Close + bass note',
      spread: 'Open + bass note',
    },
    hint: 'How the chord notes are spread over the octaves',
  });

/** The song's key, or C major when none is set. */
const keyOf = (ctx: NoteScriptContext<ParamSpecs>): KeyLike => ctx.key ?? { root: 0, scale: 'major' };

const ROOTS = ['song', ...PITCH_NAMES] as const;
const rootParam = () =>
  p.enum(ROOTS, 'song', { label: 'Key root', labels: { song: 'Song key' }, hint: 'The scale’s root note' });
const scaleParam = () =>
  p.enum(['song', ...SCALES.map((s) => s.id)], 'song', {
    label: 'Scale',
    labels: { song: 'Song key', ...Object.fromEntries(SCALES.map((s) => [s.id, s.label])) },
    hint: 'The scale to snap to ("Song key" uses the piano roll’s key)',
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
  description: 'Moves notes onto the grid. Strength 50% moves them halfway; Swing makes every second line late.',
  params: {
    grid: gridParam('snap', 'Grid', 'The grid notes move to ("Piano roll snap" follows the toolbar)'),
    strength: p.float(0, 1, 1, { label: 'Strength', unit: '%', hint: '100% = exactly on the grid' }),
    starts: p.bool(true, { label: 'Move note starts' }),
    ends: p.enum(['keep', 'snap', 'lengths'], 'keep', {
      label: 'Note ends',
      labels: { keep: 'Keep lengths', snap: 'Snap ends to the grid', lengths: 'Round lengths to the grid' },
    }),
    swing: p.float(0, 1, 0, { label: 'Swing', unit: '%', hint: 'Every second grid line is late by up to half a cell' }),
    window: p.float(0.05, 1, 1, {
      label: 'Window',
      unit: '%',
      hint: 'Only notes this close to a grid line move (100% = every note)',
    }),
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
  description: 'Adds small random changes to timing, velocity and length so the part sounds less mechanical.',
  params: {
    timing: p.float(0, 1, 0.08, {
      label: 'Timing ± (of a 1/16 note)',
      unit: '%',
      hint: 'How far notes may move early or late, as a share of a 1/16 step',
    }),
    velocity: p.float(0, 0.5, 0.1, { label: 'Velocity ±', unit: '%' }),
    length: p.float(0, 0.5, 0, { label: 'Length ±', unit: '%' }),
    seed: seedParam(),
  },
  run: (ctx) =>
    humanize(ctx.notes, {
      rand: ctx.rand,
      timing: (ctx.values.timing * ctx.ppq) / 4,
      velocity: ctx.values.velocity,
      length: ctx.values.length,
    }),
});

const legatoTool = defineNoteScript({
  id: 'agstudio.notes.legato',
  name: 'Make legato',
  version: 1,
  category: 'Timing',
  description: 'Stretches each note until the next one starts, so the line plays smoothly with no gaps.',
  params: {
    gap: gapParam('0', 'Gap before the next note', 'No gap', 'Leave a little silence between notes'),
    last: p.enum(['keep', 'pattern'], 'keep', {
      label: 'Last notes',
      labels: { keep: 'Keep their length', pattern: 'Last until the pattern end' },
    }),
  },
  run: (ctx) =>
    legato(ctx.notes, {
      gap: ticks(ctx.values.gap, ctx),
      ...(ctx.values.last === 'pattern' ? { until: ctx.length } : {}),
    }),
});

const strumTool = defineNoteScript({
  id: 'agstudio.notes.strum',
  name: 'Strum',
  version: 1,
  category: 'Timing',
  description: 'Spreads the notes of each chord out in time, like strumming a guitar.',
  params: {
    time: p.float(0, 1, 0.125, { label: 'Strum time', unit: 'beats', hint: 'From the first to the last chord note' }),
    direction: p.enum(['up', 'down', 'alternate', 'random'], 'up', {
      label: 'Direction',
      labels: {
        up: 'Up (low to high)',
        down: 'Down (high to low)',
        alternate: 'Alternate up and down',
        random: 'Random order',
      },
    }),
    curve: p.float(-1, 1, 0, {
      label: 'Curve',
      hint: '0 = even spacing; above 0 starts tight and spreads out, below 0 the reverse',
    }),
    velocity: p.float(-1, 1, 0, {
      label: 'Velocity fade',
      unit: '%',
      hint: 'Later notes get softer (−) or louder (+)',
    }),
    tolerance: gapParam(
      '1/64',
      'Chord window',
      'Same start only',
      'Notes that start this close together count as one chord',
    ),
    keepEnds: p.bool(true, { label: 'Keep note ends' }),
    seed: seedParam(),
  },
  run: (ctx) =>
    strum(ctx.notes, {
      time: ctx.values.time * ctx.ppq,
      direction: ctx.values.direction,
      curve: ctx.values.curve,
      velocity: ctx.values.velocity,
      tolerance: ticks(ctx.values.tolerance, ctx),
      keepEnds: ctx.values.keepEnds,
      rand: ctx.rand,
    }),
});

const stretchTool = defineNoteScript({
  id: 'agstudio.notes.stretch',
  name: 'Stretch',
  version: 1,
  category: 'Timing',
  description: 'Makes the notes longer or shorter in time: 2× plays at half speed, 0.5× at double speed.',
  params: { factor: p.float(0.25, 4, 2, { label: 'Length ×', unit: 'x', scale: 'log' }) },
  run: (ctx) => stretch(ctx.notes, { factor: ctx.values.factor }),
});

// ---------------------------------------------------------------------------------------------
// Edit

const chopTool = defineNoteScript({
  id: 'agstudio.notes.chop',
  name: 'Chop',
  version: 1,
  category: 'Edit',
  description: 'Cuts each note into shorter pieces, on the grid or into equal parts.',
  params: {
    mode: p.enum(['grid', 'parts'], 'grid', {
      label: 'Cut',
      labels: { grid: 'On the grid', parts: 'Into equal parts' },
    }),
    grid: gridParam('1/16', 'Grid', 'Piece length when cutting on the grid'),
    parts: p.int(2, 32, 4, { label: 'Parts', hint: 'How many pieces when cutting into equal parts' }),
    gate: p.float(0.05, 1, 1, { label: 'Piece length', unit: '%', hint: '100% = the pieces touch' }),
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
  description: 'Joins notes on the same key that touch (or have a small gap) into one long note.',
  params: {
    gap: gapParam('0', 'Join gaps up to', 'Touching notes only', 'Notes on one key this close together become one'),
  },
  run: (ctx) => glue(ctx.notes, { gap: ticks(ctx.values.gap, ctx) }),
});

const flipTool = defineNoteScript({
  id: 'agstudio.notes.flip',
  name: 'Flip',
  version: 1,
  category: 'Edit',
  description: 'Mirrors the notes: in time plays them backwards, in pitch turns the melody upside down.',
  params: {
    axis: p.enum(['time', 'pitch'], 'time', {
      label: 'Flip',
      labels: { time: 'In time (backwards)', pitch: 'In pitch (upside down)' },
    }),
  },
  run: (ctx) => flip(ctx.notes, ctx.values.axis),
});

const lengthTool = defineNoteScript({
  id: 'agstudio.notes.length',
  name: 'Set length',
  version: 1,
  category: 'Edit',
  description: 'Gives every note the same length.',
  params: { length: gridParam('1/16', 'Length', 'The length every note gets') },
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
  description: 'Moves notes that are outside a range of keys into it, by whole octaves.',
  params: {
    low: noteParam(48, 'Lowest note', 'Notes below it move up by octaves'),
    high: noteParam(72, 'Highest note', 'Notes above it move down by octaves'),
  },
  run: (ctx) => limit(ctx.notes, { low: keyOfName(ctx.values.low), high: keyOfName(ctx.values.high) }),
});

// ---------------------------------------------------------------------------------------------
// Pitch

const transposeTool = defineNoteScript({
  id: 'agstudio.notes.transpose',
  name: 'Transpose',
  version: 1,
  category: 'Pitch',
  description: 'Moves notes up or down by steps of the song key’s scale and/or by semitones.',
  params: {
    steps: p.int(-14, 14, 0, {
      label: 'Scale steps (in key)',
      hint: '+2 = up a third in the song key (C major when no key is set)',
    }),
    semitones: p.int(-48, 48, 0, { label: 'Semitones', unit: 'st', hint: '12 = one octave' }),
  },
  run: (ctx) => transpose(transposeDegrees(ctx.notes, ctx.values.steps, keyOf(ctx)), ctx.values.semitones),
});

const snapTool = defineNoteScript({
  id: 'agstudio.notes.snap-to-scale',
  name: 'Snap to scale',
  version: 1,
  category: 'Pitch',
  description: 'Moves notes that are off the scale onto the nearest note of the scale.',
  params: {
    root: rootParam(),
    scale: scaleParam(),
    direction: p.enum(['nearest', 'up', 'down'], 'nearest', {
      label: 'Move to',
      labels: { nearest: 'The nearest scale note', up: 'The scale note above', down: 'The scale note below' },
    }),
  },
  run: (ctx) => snapNotesToScale(ctx.notes, chosenKey(ctx, ctx.values.root, ctx.values.scale), ctx.values.direction),
});

const chordsTool = defineNoteScript({
  id: 'agstudio.notes.chords',
  name: 'Make chords',
  version: 1,
  category: 'Pitch',
  description: 'Turns every note into a chord built on it ("In key" uses the song key’s own chords).',
  params: {
    chord: p.enum(['diatonic', 'diatonic7', ...CHORDS.map((c) => c.id)], 'diatonic', {
      label: 'Chord',
      labels: {
        diatonic: 'In key: triads',
        diatonic7: 'In key: 7th chords',
        ...Object.fromEntries(CHORDS.map((c) => [c.id, `${c.label} (C${c.symbol})`])),
      },
    }),
    inversion: p.int(-3, 3, 0, {
      label: 'Inversion',
      hint: '0 = root position; 1 = the lowest note moves up an octave',
    }),
    voicing: voicingParam(),
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
  description: 'Makes notes louder or softer: Amount 0.5× halves every velocity, Offset adds to it.',
  params: {
    factor: p.float(0, 2, 1, { label: 'Amount', unit: 'x', hint: '1× = unchanged' }),
    offset: p.float(-1, 1, 0, { label: 'Offset', unit: '%', hint: 'Added to every velocity after scaling' }),
  },
  run: (ctx) => scaleVelocities(ctx.notes, { factor: ctx.values.factor, offset: ctx.values.offset }),
});

const velocityRangeTool = defineNoteScript({
  id: 'agstudio.notes.velocity-range',
  name: 'Velocity range',
  version: 1,
  category: 'Velocity',
  description: 'Spreads velocities between a minimum and a maximum: the softest note gets the minimum.',
  params: {
    min: p.float(0, 1, 0.4, { label: 'Softest', unit: '%' }),
    max: p.float(0, 1, 1, { label: 'Loudest', unit: '%' }),
  },
  run: (ctx) => fitVelocities(ctx.notes, { min: ctx.values.min, max: ctx.values.max }),
});

const velocityRampTool = defineNoteScript({
  id: 'agstudio.notes.velocity-ramp',
  name: 'Velocity ramp',
  version: 1,
  category: 'Velocity',
  description: 'A crescendo or fade across the notes, from the first note’s level to the last one’s.',
  params: {
    from: p.float(0, 1, 0.3, { label: 'First note', unit: '%' }),
    to: p.float(0, 1, 1, { label: 'Last note', unit: '%' }),
    curve: p.float(-1, 1, 0, { label: 'Curve', hint: '0 = straight; above 0 rises late, below 0 rises early' }),
    multiply: p.bool(false, { label: 'Scale the existing velocities' }),
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
  description: 'Plays held chords one note at a time in a pattern, at the chosen rate.',
  params: {
    pattern: p.enum(ARP_PATTERNS, 'up', {
      label: 'Pattern',
      labels: {
        up: 'Up',
        down: 'Down',
        'up-down': 'Up and down',
        'down-up': 'Down and up',
        converge: 'Outside in',
        diverge: 'Inside out',
        'as-played': 'As played',
        random: 'Random',
      },
    }),
    rate: gridParam('1/16', 'Rate', 'Time between arpeggio notes'),
    gate: p.float(0.05, 1, 0.9, { label: 'Note length', unit: '%', hint: 'Share of the rate each note lasts' }),
    octaves: p.int(1, 4, 1, { label: 'Octaves', hint: 'How many octaves the pattern climbs' }),
    range: p.int(0, 48, 0, {
      label: 'Range (0 = no limit)',
      unit: 'st',
      hint: 'Highest interval above the lowest note',
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
  description: 'Changes pitches and velocities at random, keeping the notes in the song key.',
  params: {
    pitch: p.int(0, 24, 5, { label: 'Pitch ±', unit: 'st', hint: 'How far a note may move up or down' }),
    velocity: p.float(0, 0.5, 0.15, { label: 'Velocity ±', unit: '%' }),
    inKey: p.bool(true, { label: 'Stay in the song key' }),
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
  description: 'Writes new random notes in the song key; change the Seed for a different melody.',
  params: {
    density: p.float(0, 1, 0.5, { label: 'Density', unit: '%', hint: 'Chance of a note on each rhythm step' }),
    rhythm: gridParam('1/8', 'Rhythm', 'Where notes may start'),
    low: noteParam(60, 'Lowest note', 'The bottom of the melody’s range'),
    range: p.int(0, 48, 12, { label: 'Range', unit: 'st', hint: '12 = one octave above the lowest note' }),
    minLength: p.int(1, 8, 1, { label: 'Shortest note (× rhythm)' }),
    maxLength: p.int(1, 8, 2, { label: 'Longest note (× rhythm)' }),
    smoothness: p.float(0, 1, 0.6, { label: 'Smoothness', unit: '%', hint: 'Higher = smaller jumps between notes' }),
    chords: p.int(1, 4, 1, { label: 'Notes at once', hint: '1 = a melody, more = chords' }),
    replace: p.bool(true, { label: 'Replace the existing notes' }),
    seed: seedParam(),
  },
  run: (ctx) => {
    const { start, end } = bars(ctx);
    const low = keyOfName(ctx.values.low);
    const notes = generate({
      rand: ctx.rand,
      start,
      end,
      grid: ticks(ctx.values.rhythm, ctx),
      density: ctx.values.density,
      low,
      high: low + ctx.values.range,
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
  description: 'Writes a chord progression in the song key (the numbers are the scale degrees: I = the root chord).',
  params: {
    progression: p.enum(Object.keys(PROGRESSIONS) as Progression[], 'I-V-vi-IV', {
      label: 'Progression',
      labels: Object.fromEntries(Object.keys(PROGRESSIONS).map((k) => [k, k.replaceAll('-', ' – ')])),
      hint: 'Upper case = major chords, lower case = minor (in a minor key the i is the root chord)',
    }),
    bars: p.enum(['0.5', '1', '2'], '1', {
      label: 'Chord length',
      labels: { '0.5': 'Half a bar', '1': '1 bar', '2': '2 bars' },
    }),
    size: p.enum(['3', '4', '5'], '3', {
      label: 'Notes per chord',
      labels: { '3': '3 (triads)', '4': '4 (7th chords)', '5': '5 (9th chords)' },
    }),
    octave: p.int(2, 7, 5, { label: 'Octave', hint: '5 = the octave from C5 (middle C) up' }),
    inversion: p.int(-2, 3, 0, { label: 'Inversion', hint: '0 = root position' }),
    voicing: voicingParam(),
    velocity: p.float(0.05, 1, 0.75, { label: 'Velocity', unit: '%' }),
    replace: p.bool(false, { label: 'Replace the existing notes' }),
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
