/**
 * `@agstudio/sdk/notes`: music theory and note transforms for note scripts (and anything else that
 * edits notes). Pure TypeScript, no DOM: scales and keys, chords, and transforms on `ScriptNote[]`
 * (quantize, humanize, legato, chop, glue, strum, arpeggiate, flip, transpose, velocity scaling,
 * scale-aware randomize/generate). Transforms return new notes and never mutate their input; notes
 * that keep an `id` are edits of the input note with that id, notes without one are new.
 *
 * ```ts
 * import { defineNoteScript, p } from '@agstudio/sdk';
 * import { quantize } from '@agstudio/sdk/notes';
 * export default defineNoteScript({
 *   id: 'user.tight', name: 'Tighten', version: 1,
 *   params: { amount: p.float(0, 1, 0.5, { unit: '%' }) },
 *   run: (ctx) => quantize(ctx.notes, { grid: ctx.grid, strength: ctx.values.amount }),
 * });
 * ```
 */
export * from './scales';
export * from './chords';
export {
  bend,
  byTime,
  chordGroups,
  clampNote,
  noteEnd,
  overlapGroups,
  seeded,
  span,
  withoutId,
  type Rand,
  type Span,
} from './util';
export * from './timing';
export * from './pitch';
export * from './velocity';
export * from './generate';
