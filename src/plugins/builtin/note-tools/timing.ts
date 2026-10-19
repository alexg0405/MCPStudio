/** The timing tools: Quantize, Humanize, Make legato, Strum and Stretch. */
import { defineNoteScript, p } from '@agstudio/sdk';
import { humanize, legato, quantize, strum, stretch } from '@agstudio/sdk/notes';
import { gapParam, gridParam, seedParam, ticks } from './shared-params';

export const quantizeTool = defineNoteScript({
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

export const humanizeTool = defineNoteScript({
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

export const legatoTool = defineNoteScript({
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

export const strumTool = defineNoteScript({
  id: 'agstudio.notes.strum',
  name: 'Strum',
  version: 1,
  category: 'Timing',
  description: 'Spreads the notes of each chord out in time, like strumming a guitar.',
  params: {
    time: p.float(0, 1, 0.125, { label: 'Strum time', unit: 'beats', hint: 'From the first to the last chord note' }),
    ms: p.float(0, 500, 0, {
      label: 'Strum time in ms',
      unit: 'ms',
      hint: 'Above 0 it replaces the beats value: the strum lasts this many milliseconds whatever the tempo (30 ms is a tight strum, 120 ms a slow one)',
    }),
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
      // Milliseconds win when set: a strum feels the same length at any tempo.
      time: ctx.values.ms > 0 ? (ctx.values.ms / 1000) * (ctx.bpm / 60) * ctx.ppq : ctx.values.time * ctx.ppq,
      direction: ctx.values.direction,
      curve: ctx.values.curve,
      velocity: ctx.values.velocity,
      tolerance: ticks(ctx.values.tolerance, ctx),
      keepEnds: ctx.values.keepEnds,
      rand: ctx.rand,
    }),
});

export const stretchTool = defineNoteScript({
  id: 'agstudio.notes.stretch',
  name: 'Stretch',
  version: 1,
  category: 'Timing',
  description: 'Makes the notes longer or shorter in time: 2× plays at half speed, 0.5× at double speed.',
  params: { factor: p.float(0.25, 4, 2, { label: 'Length ×', unit: 'x', scale: 'log' }) },
  run: (ctx) => stretch(ctx.notes, { factor: ctx.values.factor }),
});
