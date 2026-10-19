/**
 * Harmony voices from a sung lead (`make_harmonies`, `update_harmonies`): the work is rendering audio in the background, so the
 * handlers check the request and queue the app command (`harmonies.make`, `harmonies.update`) as an after-step of the answer,
 * which makes the tracks as one undo step of its own.
 */
import { harmonyVoices, voicesOfLead } from '@core/query/harmony-voices';
import { describeRule } from '@core/harmony/voices';
import type { AudioClip, ClipId } from '@core/model/types';
import { leadProblem } from '../../harmony/voice-lead';
import { specFromArgs } from '../../harmony/voice-args';
import { HarmonySpecError } from '../../harmony/voice-spec';
import { staleHarmonyCount } from '../../harmony/voices';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { bool, isObj, str } from './values';

/** One voice of `make_harmonies`. */
const VOICE = {
  type: 'object',
  additionalProperties: false,
  description: 'One harmony voice.',
  properties: {
    rule: S.str(
      'What it sings: "third_above", "third_below", "fifth_above", "fifth_below", "sixth_above", "sixth_below", "octave_above", "octave_below" (diatonic, in the song key), "diatonic" with interval ("3rd above", "5th below"…), "chord_above" / "chord_below" (the nearest chord tone of the chord track, voices keep their order), "fixed" with interval in semitones, or "guide" with channel (an instrument channel whose notes it sings).',
    ),
    interval: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'For "diatonic": "3rd above", "5th below", "6th"… For "fixed": semitones (+7 = a fifth above).' },
    level: S.num('Level against the lead, dB (−24…+6). Default −6 for one voice, −9 for several.'),
    pan: S.num('−1 (left) … 1 (right). Default: spread across the stereo field.'),
    formant: S.num('Moves the vowel colour in cents (−300…300) so the voice sounds like another singer. Default 0.'),
    channel: S.str('For "guide": the instrument channel (id or name) whose notes it sings.'),
  },
  required: ['rule'],
};

export const harmonyVoicesOps: OpModule = {
  schemas: [
    S.op(
      'make_harmonies',
      'Makes 1–4 harmony voices from a sung audio clip (one clear voice): each is a new audio clip on its own track under the lead, a PSOLA render of the lead’s notes moved to the voice’s target, so it can be mixed on its own. The clip is found by id, or by track + bar. Diatonic rules need the song key; chord rules follow the chord track. humanize keeps the voices from phasing (timing_ms ±0–40, drift_cents ±0–40, vibrato 0–1 how different the vibrato is). The voices are rendered in the background (a few seconds); Undo removes them all.',
      {
        clip: S.str('The sung audio clip id (clip_…).'),
        track: S.int('With bar: the 1-based track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays.'),
        voices: { type: 'array', description: 'The voices, 1–4, from nearest the lead outwards.', items: VOICE },
        humanize: {
          type: 'object',
          additionalProperties: false,
          description: 'How the voices differ from the lead and each other (defaults: 12 ms, 6 cents, 0.3).',
          properties: { timing_ms: S.num('Each note starts up to this many ms early or late (0–40).'), drift_cents: S.num('Each note is up to this many cents off (0–40).'), vibrato: S.num('How different each note’s vibrato is from the lead’s, 0–1.') },
        },
        seed: S.int('Optional: makes the take repeatable.'),
      },
      ['voices'],
    ),
    S.op(
      'update_harmonies',
      'Makes harmony voices again from their lead as it is now (after the sung line, the chord track or the song key changed). Without a clip: every harmony in the song that is out of date. With a clip (a lead, or one of its harmony clips): that lead’s voices. force remakes voices that are up to date too. Tracks, levels and pans stay; one undo step.',
      {
        clip: S.str('A lead clip id, or one of its harmony clips (default: all harmonies).'),
        force: S.bool('Remake voices that are up to date as well.'),
      },
    ),
  ],
  prompt: {
    id: 'harmony-voices',
    order: 17,
    text: `Harmony voices: make_harmonies turns a recorded vocal into 1–4 backing voices on new tracks under it ("add a third above and a fifth below" is two voices, third_above and fifth_below). Diatonic voices (third_above…) follow the song key, so set it first (song action); chord_above / chord_below follow the chord track (several keep their order and move smoothly); fixed is a set number of semitones; guide sings the notes of an instrument channel. Keep level around −6 to −10 dB and spread the pans; humanize (the default) keeps stacks from phasing. They render in the background, so say they will appear in a moment. After changing the vocal, the chords or the key, update_harmonies remakes the out-of-date voices. The AI cannot hear them: ask the musician to listen.`,
  },
  handlers: {
    make_harmonies: (action, context) => {
      const clip = context.clip(action);
      if (clip.kind !== 'audio') return fail('only a recorded vocal (an audio clip) can have harmonies made from it');
      const problem = leadProblem(context.base, clip.id as ClipId);
      if (problem) return fail(problem);
      let spec;
      try {
        spec = specFromArgs(context.services, { voices: action.voices, humanize: action.humanize, seed: action.seed });
      } catch (e) {
        return fail(e instanceof HarmonySpecError ? e.message : String(e));
      }
      if (spec.voices.some((v) => v.rule.kind === 'interval') && !context.base.transport.key) {
        return fail('the song has no key: set it first (song action with key), or use chord or fixed voices');
      }
      context.focus.clip(clip.id as ClipId, 'harmonies');
      context.state.after.push({
        kind: 'command',
        id: 'harmonies.make',
        args: { clip: clip.id, voices: action.voices, ...(isObj(action.humanize) ? { humanize: action.humanize } : {}), ...(action.seed !== undefined ? { seed: action.seed } : {}) },
        gesture: false,
      });
      const channel = context.project.channels[(clip as AudioClip).channelId];
      const names = spec.voices.map((v) => describeRule(v.rule)).join(', ');
      return `Making ${spec.voices.length} harmony ${spec.voices.length === 1 ? 'voice' : 'voices'} (${names}) from “${channel?.name ?? 'the clip'}”; they appear on new tracks under it in a moment`;
    },
    update_harmonies: (action, context) => {
      const base = context.base;
      const id = str(action.clip);
      const total = harmonyVoices(base).length;
      if (total === 0) return fail('there are no harmony voices to update: make some with make_harmonies');
      if (id) {
        const found = base.playlist.clips[id as ClipId];
        if (found?.kind !== 'audio') return fail(`there is no audio clip "${id}"`);
        const lead = found.harmony?.source ?? found.id;
        if (voicesOfLead(base, lead).length === 0) return fail('that clip has no harmony voices');
      }
      const force = bool(action.force) === true;
      context.state.after.push({ kind: 'command', id: 'harmonies.update', args: { ...(id ? { clip: id } : {}), ...(force ? { force: true } : {}) }, gesture: false });
      const stale = staleHarmonyCount(base);
      return force ? 'Making the harmony voices again from their lead' : stale > 0 ? `Updating ${stale} out-of-date harmony ${stale === 1 ? 'voice' : 'voices'}` : 'Checking the harmonies (they look up to date)';
    },
  },
};
