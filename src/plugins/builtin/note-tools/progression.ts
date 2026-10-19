/** The Chord progression tool: writes a progression of chords in the song key. */
import { defineNoteScript, p, type ScriptNote } from '@agstudio/sdk';
import { diatonicChord, transposeInScale } from '@agstudio/sdk/notes';
import { barSpan, voicingParam } from './shared-params';

/** The progressions on offer, as scale degrees counted from 0 (0 = the root chord, 4 = the chord on the fifth note). */
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

export const progressionTool = defineNoteScript({
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
    const start = barSpan(ctx).start;
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
