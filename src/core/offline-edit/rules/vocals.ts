/**
 * Recorded vocals: "add harmonies" (`make_harmonies`, with the voices the words name) and "clean up the vocal" (`clean_vocal`:
 * noise, breaths, mouth clicks). Both work on audio clips that are a voice, in the part named or everywhere.
 */
import type { AudioClip } from '../../model/types';
import { clipsOverlapping } from '../vocal-clips';
import { byAmount, decibelsIn } from '../words';
import type { OfflineAction, Rule, RuleContext, RuleResult } from '../types';

const HARMONIES =
  /\b(?:(?<!re-?)harmon(?:y|ies|ise|ize|ising|izing)|backing (?:vocals?|voices?|singers?)|double (?:the )?(?:vocals?|voice|vox)|stack(?:ed)? (?:the )?(?:vocals?|vox)|(?:add|put|give)(?: it| the vocals?)?(?: some| a| an)? (?:third|fifth|sixth|octave)s? (?:above|below))\b/;
const CLEAN_VERB =
  /\b(?:(?:take|turn|bring|pull|knock) (?:the |those )?(?:breaths?|noise|hiss|clicks?)[^.]*\b(?:down|out|away)\b|clean(?:ing)?(?: it| the \w+)? up|clean|de-?noise|tidy|polish|remove (?:(?:a lot|some|most|all|a bit|a little) of )?(?:the )?(?:background )?(?:noise|hiss|hum|breaths?|clicks?|mouth clicks?|lip smacks?)|reduce (?:(?:a lot|some|most|all|a bit|a little) of )?(?:the )?(?:noise|breaths?|clicks?)|get rid of (?:the )?(?:noise|hiss|hum|breaths?|clicks?)|(?:breaths?|noise|hiss) (?:are |is )?(?:too )?(?:loud|much|bad|noticeable)|noisy|hissy)\b/;
const VOCAL_WORD = /\b(?:vocals?|vox|voice|singing|singer|recording|take|acapella|a cappella)\b/;
const NOISE_WORDS = /\b(?:noise|noisy|hiss|hissy|hum|background|room)\b/;
const BREATH_WORDS = /\bbreath/;
const CLICK_WORDS = /\bclicks?\b|\blip smacks?\b|\bmouth\b/;

/** Most recorded clips one request works on (each is rendered in the background). */
const MAX_CLIPS = 8;

/** How one interval word is sung: its rule name and, with no song key, the semitones it is instead. */
const INTERVAL_WORDS: Readonly<Record<string, { name: string; semitones: number }>> = {
  third: { name: 'third', semitones: 4 },
  '3rd': { name: 'third', semitones: 4 },
  fifth: { name: 'fifth', semitones: 7 },
  '5th': { name: 'fifth', semitones: 7 },
  sixth: { name: 'sixth', semitones: 9 },
  '6th': { name: 'sixth', semitones: 9 },
  octave: { name: 'octave', semitones: 12 },
};

/** The voices of an unspecific "add harmonies", by how many: a third above, a fifth below, an octave up, a sixth below. */
const DEFAULT_VOICES: readonly (readonly [string, 'above' | 'below'])[] = [
  ['third', 'above'],
  ['fifth', 'below'],
  ['octave', 'above'],
  ['sixth', 'below'],
];
const COUNT_WORDS: Readonly<Record<string, number>> = { one: 1, a: 1, single: 1, two: 2, three: 3, four: 4, '1': 1, '2': 2, '3': 3, '4': 4 };

/** The voices a request names: "a third above and a fifth below" is two; "three harmonies" is the first three defaults. */
function voicesIn(text: string): (readonly [string, 'above' | 'below'])[] {
  const named: (readonly [string, 'above' | 'below'])[] = [];
  for (const found of text.matchAll(/\b(third|3rd|fifth|5th|sixth|6th|octave)s?\s*(above|below|up|down|higher|lower)?/g)) {
    const interval = INTERVAL_WORDS[found[1] as string];
    if (!interval) continue;
    const direction = /below|down|lower/.test(found[2] ?? '') ? 'below' : 'above';
    named.push([interval.name, direction]);
  }
  if (named.length > 0) return named.slice(0, 4);
  const count = /\b(one|two|three|four|[1-4])\s*(?:part\s+)?(?:harmon|voices?|backing)/.exec(text)?.[1];
  const wanted = count ? (COUNT_WORDS[count] ?? 2) : 2;
  return DEFAULT_VOICES.slice(0, wanted);
}

/** The levels and pans of the voices: quieter when there are several, spread left and right. */
const VOICE_PANS = [-0.4, 0.4, -0.7, 0.7] as const;

function voiceSpec(interval: readonly [string, 'above' | 'below'], index: number, count: number, hasKey: boolean): Record<string, unknown> {
  const [name, direction] = interval;
  const level = count === 1 ? -6 : -9;
  const pan = VOICE_PANS[index] ?? 0;
  if (hasKey) return { rule: `${name}_${direction}`, level, pan };
  const semitones = (INTERVAL_WORDS[name]?.semitones ?? 4) * (direction === 'below' ? -1 : 1);
  return { rule: 'fixed', interval: semitones, level, pan };
}

/** The voice clips in the part named (the whole song when none is), capped. */
function vocalClips(context: RuleContext): { clips: AudioClip[]; extra: number } {
  const all = clipsOverlapping(context.facts, context.scope.isNamed ? context.scope.ranges : []);
  return { clips: all.slice(0, MAX_CLIPS), extra: Math.max(0, all.length - MAX_CLIPS) };
}

const NO_VOCAL = 'There is no recorded vocal in the song to work on. Record one (or drop an audio file on the playlist) first.';

function makeHarmonies(context: RuleContext): RuleResult {
  const { facts, text, scope } = context;
  const { clips, extra } = vocalClips(context);
  if (clips.length === 0) return { reply: scope.isNamed ? `There is no recorded vocal in ${scope.label}. ${NO_VOCAL}` : NO_VOCAL };
  const intervals = voicesIn(text);
  const hasKey = facts.project.transport.key !== null && facts.project.transport.key !== undefined;
  const voices = intervals.map((interval, index) => voiceSpec(interval, index, intervals.length, hasKey));
  const actions: OfflineAction[] = clips.map((clip) => ({ op: 'make_harmonies', clip: clip.id, voices, seed: context.seed % 100000 }));
  const sung = intervals.map(([name, direction]) => `a ${name} ${direction}`).join(' and ');
  const keyNote = hasKey ? '' : ' The song has no key set, so the voices are fixed distances from the vocal.';
  const more = extra > 0 ? ` (${extra} more vocal clips were left out: ask about a part to do those)` : '';
  return {
    message: `Making harmonies for ${clips.length === 1 ? 'the vocal' : `${clips.length} vocal clips`}: ${sung}. They are rendered in the background and appear on new tracks under the vocal in a moment.${keyNote}${more}`,
    actions,
  };
}

function cleanVocal(context: RuleContext): RuleResult {
  const { text, amount, scope } = context;
  const { clips, extra } = vocalClips(context);
  if (clips.length === 0) return { reply: scope.isNamed ? `There is no recorded vocal in ${scope.label}. ${NO_VOCAL}` : NO_VOCAL };
  const wantsNoise = NOISE_WORDS.test(text);
  const wantsBreaths = BREATH_WORDS.test(text);
  const wantsClicks = CLICK_WORDS.test(text);
  const isAll = !wantsNoise && !wantsBreaths && !wantsClicks;
  const named = decibelsIn(text);
  const fields: Record<string, unknown> = {};
  const said: string[] = [];
  if (isAll || wantsNoise) {
    const noise = named !== null && wantsNoise && !wantsBreaths ? Math.abs(named) : byAmount(amount, [6, 12, 20]);
    fields.noise_db = noise;
    said.push(`background noise down ${noise} dB`);
  }
  if (isAll || wantsBreaths) {
    const breaths = named !== null && wantsBreaths && !wantsNoise ? Math.abs(named) : byAmount(amount, [6, 10, 20]);
    fields.breaths_db = breaths;
    said.push(`breaths down ${breaths} dB`);
  }
  if (isAll || wantsClicks) {
    fields.clicks = true;
    said.push('mouth clicks removed');
  }
  const actions: OfflineAction[] = clips.map((clip) => ({ op: 'clean_vocal', clip: clip.id, ...fields }));
  const more = extra > 0 ? ` (${extra} more vocal clips were left out: ask about a part to do those)` : '';
  return {
    message: `Cleaning up ${clips.length === 1 ? 'the vocal' : `${clips.length} vocal clips`}: ${said.join(', ')}. The cleaned sound is made in the background, and the original recording is kept.${more}`,
    actions,
  };
}

/** Harmonies and vocal cleanup. */
export const VOCAL_RULES: readonly Rule[] = [
  { id: 'harmonies', matches: (_text, clause) => HARMONIES.test(clause), run: makeHarmonies },
  {
    id: 'clean-vocal',
    matches: (_text, clause) => CLEAN_VERB.test(clause) && (VOCAL_WORD.test(clause) || NOISE_WORDS.test(clause) || BREATH_WORDS.test(clause) || CLICK_WORDS.test(clause)),
    run: cleanVocal,
  },
];
