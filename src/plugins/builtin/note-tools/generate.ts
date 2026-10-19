/** The tools that write or rearrange notes from a pattern: Arpeggiate, Randomize and Generate melody. */
import { defineNoteScript, p } from '@agstudio/sdk';
import { ARP_PATTERNS, arpeggiate, generate, randomize } from '@agstudio/sdk/notes';
import { barSpan, gridParam, keyOf, keyOfName, noteParam, seedParam, ticks } from './shared-params';

export const arpTool = defineNoteScript({
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

export const randomizeTool = defineNoteScript({
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

export const generateTool = defineNoteScript({
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
    const { start, end } = barSpan(ctx);
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
