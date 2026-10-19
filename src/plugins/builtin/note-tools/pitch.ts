/** The pitch tools: Transpose, Snap to scale and Make chords. */
import { defineNoteScript, p } from '@agstudio/sdk';
import { CHORDS, chordify, snapNotesToScale, transpose, transposeDegrees } from '@agstudio/sdk/notes';
import { chosenKey, keyOf, rootParam, scaleParam, voicingParam } from './shared-params';

export const transposeTool = defineNoteScript({
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

export const snapTool = defineNoteScript({
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

export const chordsTool = defineNoteScript({
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
