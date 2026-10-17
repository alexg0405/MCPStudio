/** The beat writer: a complete drum/808/melody pattern in one action. */
import { BEAT_JSON_SCHEMA, validateBeatSpec } from '@core/beat/spec';
import { GROOVE, STYLE_LABELS, STYLES, TEMPO, type Style } from '@core/beat/style';
import type { ChannelId } from '@core/model/types';
import { planBeat, writeBeat, type AppliedBeat } from '../../assistant/apply';
import { paletteText } from '../../assistant/palette';
import * as S from '../schema/parts';
import { fail, type AnswerState, type OpModule } from './context';
import { lower, str } from './values';

const { message: _message, ...beatProps } = BEAT_JSON_SCHEMA.properties;

/** What the beats of one answer share. */
export interface BeatAnswerState {
  /** Beats written so far. */
  count: number;
  /** Channels the answer's beats created (later beats may set their sound too). */
  own: Set<ChannelId>;
  /** Channels whose level a beat set (the mix setup leaves them alone). */
  levels: Set<ChannelId>;
}

export function beatAnswerState(state: AnswerState): BeatAnswerState {
  let b = state.bag.get('beat') as BeatAnswerState | undefined;
  if (!b) {
    b = { count: 0, own: new Set(), levels: new Set() };
    state.bag.set('beat', b);
  }
  return b;
}

/** How each style feels, for the prompt (tempo and swing come from the style table). */
const FEEL: Record<Style, string> = {
  trap: 'half-time: snare or clap on beat 3 of each bar, rolling hats with 1/32 and triplet rolls, sliding 808s',
  drill: 'snares on beat 3 (and the "and" of 4 now and then), syncopated kicks, triplet hat rolls, sliding 808s',
  boombap: 'kick on 1 and the "and" of 2 or 3, snare on 2 and 4, swung 8th/16th hats, ghost snares, a sub bass following the kick',
  lofi: 'soft and swung: lazy kick, snare on 2 and 4, quiet hats, 7th chords on keys, warm bass',
  house: 'four on the floor, clap on 2 and 4, offbeat open hats, a pluck or organ bass on the offbeats',
  edm: 'four on the floor, clap on 2 and 4, driving offbeat hats, supersaw chords and a big lead',
  reggaeton: 'dembow: kick on every beat, snare on the 4th and 7th 1/16 of each half bar (steps 3, 6, 11, 14)',
  afro: 'syncopated kick, rim and shaker patterns, swung 1/16 hats, marimba or guitar plucks',
  pop: 'kick on 1 and 3, snare or clap on 2 and 4, steady 8th hats, big chords and a catchy lead',
  bigroom:
    'festival drop: four on the floor, a punchy kick, clap on 2 and 4, offbeat open hats, a mono lead over sidechained supersaw pads and an offbeat bass; builds are snare rolls and a pitch riser (the arranger adds them)',
  proghouse:
    'four on the floor, clap on 2 and 4, offbeat hats, a rolling 16th bass between the kicks, piano or pluck chords and arps; long builds with filter sweeps, an emotional breakdown',
  futurebass:
    'half-time: kick on 1 (and a syncopated one), snare and clap together on beat 3, hats in 8ths or triplets; supersaw chords under a sidechain "wobble" with pitch bends, a sub on the roots, vocal-chop leads',
  dubstep:
    'half-time and sparse: kick on 1, snare on beat 3, a few hats; a sub under it and a growl or wobble bass (preset "Growl bass", or "Riddim wobble" for riddim: short, stuttering, repeated notes); silence before the drop',
  melodicdub:
    'half-time like dubstep but emotional: kick on 1, snare and clap on 3, big supersaw chords and pianos, a vocal-chop lead, a sub, lots of reverb',
  techhouse:
    'four on the floor with shuffled 16th hats (swing 0.3), a clap on 2 and 4, rim and percussion, a groovy rolling bassline, minimal chord stabs and a vocal shot now and then',
  trance:
    'four on the floor, clap on 2 and 4, offbeat open hats, an offbeat bass, held supersaw chords the "Gated supersaw" preset chops into 16ths (or 16th pluck arps) and long builds with snare rolls',
  dnb: 'two-step: kick on 1 and the "and" of 3, snare on 2 and 4 with ghost snares, busy hats, a reese or sub bass following the kick; liquid adds chords and keys, neuro keeps it to a growling reese',
};

const styleTable = () =>
  STYLES.map(
    (st) =>
      `- ${STYLE_LABELS[st]} ("${st}"): ${TEMPO[st].min}–${TEMPO[st].max} BPM (about ${TEMPO[st].default}), swing ${GROOVE[st].swing}: ${FEEL[st]}.`,
  ).join('\n');

export const beat: OpModule = {
  schemas: [
    S.op(
      'beat',
      'Writes a complete drum/808/melody pattern (the beat writer): a new pattern, or a rewrite of the conversation’s beat or of a pattern you name.',
      {
        pattern: S.str(
          '"new" for a new pattern (what every beat after the first in an answer does anyway), a pattern (its name, id or @ref) to rewrite it, or leave it out to change the conversation’s beat (follow-ups).',
        ),
        ref: S.REF,
        ...beatProps,
      },
      ['title', 'bars', 'tracks'],
    ),
  ],
  prompt: {
    id: 'beat',
    order: 80,
    text: `Beat writing (the "beat" action). Grid: 4/4, 16 steps per bar (1/16 notes). Bar b, beat q (both 1-based) starts at step (b-1)*16 + (q-1)*4. Fractional steps make rolls: +0.5 is a 1/32 note, thirds give triplets. Lengths are in steps.
Sounds: drum samples (no key): kick, snare, clap, hat (closed), open-hat, tom-low, tom-mid, tom-high, rim, cowbell, crash. 808: sine bass with punch, drive and glide; a note that starts before the previous 808 note ends glides to its pitch (overlap by half a step and change the key). Pitched, with MIDI keys: bass, lead, pad, pluck, keys, bell, strings.
Patterns: every beat after the first in an answer makes a new pattern (or say pattern "new"); name a pattern (its name, id or @ref) to rewrite it; leave pattern out to change the conversation's beat ("busier hats"). Give beats a ref ("@verse") to place or arrange them in the same answer. Tracks with the same name share one channel and its sound across beats (the Drop's "Lead" plays the Verse's "Lead"); name a part differently for a different sound.
Always set style: it picks the drum kit, the sound of each new track (below), the accents and, when the song has no swing yet, the swing. Leave vel out unless a note needs a particular velocity: the style accents hats per 1/16, kicks on the downbeat, snares on the backbeat with soft ghost notes, and rolls rise. Open hats on their own track stop at the next closed hat. Leave volume_db out: every sound starts at a level that sits in the mix (setup_mix and level_mix then balance the buses); set it only when a part should sit clearly lower or higher. preset plays a pitched track on another sound (any preset name from the catalog).
Styles (tempo, swing, feel):
${styleTable()}
What new tracks play in each style:
${paletteText()}
Make it sound finished and professional in that style:
- 808s sit around C1–C2 (MIDI 24–40), land the root on the downbeat, follow or answer the kick, ring long and slide into new notes now and then. Stay in one key.
- Hats carry the groove: vary them (rolls into snares and bar ends in trap and drill, open hats on offbeats in house).
- Dance styles: give the drop a punchy kick and ONE clear lead or bass hook, keep the sub to one voice, leave room for the vocal or lead. Map requests to a style: "a drop like Martin Garrix" or "festival drop" is bigroom; "Flume-ish" or "future bass" is futurebass; "Skrillex-style", "growl" or "riddim" is dubstep; "Illenium-ish" or "melodic dubstep" is melodicdub; "progressive house" (the Eric Prydz and Swedish House Mafia end of it) is proghouse; "tech house" or "Fisher-style" is techhouse; "trance" or "Armin-style" is trance; "drum and bass", "liquid", "neurofunk" or "jungle" is dnb. The artist names only point at the subgenre: write original notes in it, never anyone's actual melody or chord progression.
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
      const answer = beatAnswerState(state);
      const want = str(a.pattern);
      let previous: AppliedBeat | null = null;
      let patternId: ReturnType<typeof c.pattern> | undefined;
      if (want && lower(want) !== 'new') {
        // A pattern it names (in a part of the song: the part's own copy).
        patternId = c.focus.writable(c.pattern(want));
        const last = state.beatPlan ?? c.apply.previousBeat;
        if (last?.patternId === patternId)
          previous = { patternId, channels: last.channels, created: [...last.created] };
      } else if (!want && answer.count === 0 && c.apply.previousBeat) {
        // A follow-up rewrites the conversation's beat (on the part's own copy when it also plays outside it).
        const prior = c.apply.previousBeat;
        const own = c.focus.writable(prior.patternId);
        previous = own !== prior.patternId ? { ...prior, patternId: own } : prior;
      }
      // Rewriting a whole pattern isn't possible while only some of its notes are selected.
      const target = patternId ?? previous?.patternId;
      if (target) c.focus.wholePattern(target, null, 'beat');
      const plan = planBeat(s, project, spec, previous, {
        ...(patternId ? { patternId } : {}),
        own: answer.own,
      });
      const rewrite = !!project.patterns[plan.patternId];
      writeBeat(s, d, spec, plan);
      state.warnings.push(...plan.warnings);
      for (const id of plan.created) answer.own.add(id);
      for (const id of plan.levels) answer.levels.add(id);
      answer.count++;
      state.beatPlan = plan;
      c.remember(a.ref, { kind: 'pattern', id: plan.patternId });
      const what = `“${spec.title}” (${spec.tracks.map((t) => t.name).join(', ')})`;
      return rewrite && patternId ? `Rewrote the beat ${what}` : `Wrote the beat ${what}`;
    },
  },
};
