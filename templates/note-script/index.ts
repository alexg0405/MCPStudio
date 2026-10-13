/**
 * __PLUGIN_NAME__: a note script (a piano-roll tool). It shows up in the piano roll's Tools menu (and
 * Edit > Piano roll tools); running it opens a dialog built from `params` with a live preview, and
 * applying it is one undo step. Edit and save: the menu picks up your changes right away.
 * Guide: docs/plugin-sdk.md ("Note scripts").
 */
import { defineNoteScript, p } from '@agstudio/sdk';
import { clampNote, transposeInScale } from '@agstudio/sdk/notes';

export default defineNoteScript({
  id: '__PLUGIN_ID__',
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'My tools',
  description: 'Repeats every note as fading echoes that climb the song key.',
  params: {
    echoes: p.int(1, 8, 3, { label: 'Echoes' }),
    delay: p.float(0.25, 4, 1, { label: 'Delay', unit: 'beats' }),
    decay: p.float(0, 1, 0.6, { label: 'Decay', unit: '%' }),
    climb: p.int(-7, 7, 0, { label: 'Climb (scale steps)' }),
  },

  // ctx.notes: the selected notes (or every note of the pattern), ticks at ctx.ppq (960) per beat.
  // Return the notes that replace them: keep a note's id to keep or edit it, leave the id out to add
  // a note; notes you don't return are deleted. Never modify ctx.notes itself.
  run(ctx) {
    const { echoes, delay, decay, climb } = ctx.values;
    const key = ctx.key ?? { root: 0, scale: 'major' };
    const out = [...ctx.notes];
    for (const n of ctx.notes) {
      for (let i = 1; i <= echoes; i++) {
        out.push(
          clampNote({
            tick: n.tick + Math.round(i * delay * ctx.ppq),
            length: n.length,
            key: transposeInScale(n.key, climb * i, key.root, key.scale),
            velocity: n.velocity * Math.pow(decay, i),
          }),
        );
      }
    }
    return out;
  },
});
