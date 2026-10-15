/** The beat writer: a complete drum/808/melody pattern in one action. */
import { validateBeatSpec } from '@core/beat/spec';
import { BEAT_JSON_SCHEMA } from '@core/beat/spec';
import { planBeat, writeBeat } from '../../assistant/apply';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';

const { message: _message, ...beatProps } = BEAT_JSON_SCHEMA.properties;

export const beat: OpModule = {
  schemas: [
    S.op(
      'beat',
      'Writes a complete drum/808/melody pattern (the beat writer; follow-ups with a beat change the same pattern).',
      beatProps,
      ['title', 'bars', 'tracks'],
    ),
  ],
  prompt: {
    id: 'beat',
    order: 80,
    text: `Beat writing (the "beat" action). Grid: 4/4, 16 steps per bar (1/16 notes). Bar b, beat q (both 1-based) starts at step (b-1)*16 + (q-1)*4. Fractional steps make rolls: +0.5 is a 1/32 note, thirds give triplets. Lengths are in steps.
Sounds: drum samples (no key): kick, snare, clap, hat (closed), open-hat, tom-low, tom-mid, tom-high, rim, cowbell, crash. 808: sine bass with punch, drive and glide; a note that starts before the previous 808 note ends glides to its pitch. bass (synth bass), lead, pad, pluck: pitched, need MIDI keys.
Make it sound finished and professional in the requested style:
- Tempos: trap 130–150 with a half-time feel (snare or clap on beat 3 of each bar); drill 140–145 with sliding 808s, snares on beat 3 and syncopated kicks; boom bap 85–95 with swing about 0.15; lofi 70–90, swung and soft; house 120–128, four on the floor; reggaeton about 95 (dembow).
- 808s sit around C1–C2 (MIDI 24–40), land the root on the downbeat, follow or answer the kick, ring long and slide into new notes now and then. Stay in one key.
- Hats carry the groove: vary velocities (accents and ghost notes); add 1/32 or triplet rolls into snares and bar ends in trap and drill.
- Give the last bar some variation (a fill, a roll, an 808 slide). 3–8 tracks, bars 1–4 (2 is a good default).
- When they ask to change the beat ("busier hats"), send the whole beat again with only that changed.
When they performed something (beatbox or humming), you get it as events on the grid with the instrument they meant: follow its rhythm closely and keep their steps; keep a hummed contour (intervals, slides) but move it into the right register and key; build the rest around it. Performance summaries name notes scientifically (C4 = MIDI 60).`,
  },
  handlers: {
    beat: (a, c) => {
      const { s, d, project, state } = c;
      // Without a style the beat's own tempo, swing and kick pattern decide it (accents, kit, sounds).
      const checked = validateBeatSpec(
        { ...a, message: c.answer.message },
        { project: { bpm: d.transport.bpm, swing: d.transport.swing } },
      );
      if ('error' in checked) fail(`the beat can't be used: ${checked.error}`);
      const { spec, warnings: w } = checked as Exclude<typeof checked, { error: string }>;
      state.warnings.push(...w);
      const prior = state.beatPlan
        ? { patternId: state.beatPlan.patternId, channels: state.beatPlan.channels, created: [...state.beatPlan.created] }
        : c.apply.previousBeat;
      // Rewriting a pattern that also plays outside the part: on the part's own copy.
      const own = prior ? c.focus.writable(prior.patternId) : null;
      const previous = prior && own !== prior.patternId ? { ...prior, patternId: own! } : prior;
      state.beatPlan = planBeat(s, project, spec, previous);
      writeBeat(s, d, spec, state.beatPlan);
      return `Wrote the beat “${spec.title}” (${spec.tracks.map((t) => t.name).join(', ')})`;
    },
  },
};
