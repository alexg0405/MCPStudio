/** The editing tools: Chop, Glue, Flip, Set length and Limit range. */
import { defineNoteScript, p } from '@agstudio/sdk';
import { chop, flip, glue, limit } from '@agstudio/sdk/notes';
import { gapParam, gridParam, keyOfName, noteParam, ticks } from './shared-params';

export const chopTool = defineNoteScript({
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

export const glueTool = defineNoteScript({
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

export const flipTool = defineNoteScript({
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

export const lengthTool = defineNoteScript({
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

export const limitTool = defineNoteScript({
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
