/**
 * Drum edits in plain words: busier or simpler hats and drums, taking a drum part out, adding a fill or a hat roll. They use the
 * arranger's own variations (`vary`), which change only the clips in the bars named and give each its own variant of the pattern.
 */
import type { Role } from '../../arrange/roles';
import { byAmount } from '../words';
import { DRUM_ROLES, HAT_ROLES, KICK_ROLES, SNARE_ROLES, BASS_ROLES } from '../song-facts';
import { hasPart, nothingThereReply, varyOver } from '../rule-kit';
import type { OfflineAction, Rule, RuleContext, RuleResult } from '../types';

/** Longest run of fill or roll actions one request writes (a long song has a section end every few bars). */
const MAX_END_ACTIONS = 12;

const HATS = /\b(?:hi-?hats?|hats?|hh)\b/;
const BUSIER =
  /\b(?:busier|busy|denser|more (?:hi-?hats?|hats?|drums|percussion|hat rolls?|movement|active|complex|intense|going on|energy|groove)|add (?:some |more )?(?:hi-?hats?|hats?|hat rolls?)|doubl(?:e|ed) (?:the )?(?:hi-?hats?|hats?)|faster (?:hi-?hats?|hats?)|rolling (?:hi-?hats?|hats?)|(?:hi-?hats?|hats?) (?:busier|faster|denser|more))\b/;
const SIMPLER =
  /\b(?:simpler|simple|less busy|less (?:hi-?hats?|hats?|drums|percussion|movement|going on|active|cluttered)|fewer (?:hi-?hats?|hats?|drums|hits)|sparser|sparse|minimal|strip(?:ped)?(?: it)? (?:back|down)|thin(?:ner)?(?: it)? out|too busy|more space|(?:hi-?hats?|hats?) (?:simpler|slower|sparser|less))\b/;
const DRUM_PARTS = '(?:hi-?hats?|hats?|kick|snare|claps?|percussion|perc|drums|808|bass)';
const PART_OUT = new RegExp(
  `\\b(?:no|remove|without|lose|kill|take out|get rid of|delete|cut out|leave out)\\s+(?:the\\s+)?${DRUM_PARTS}s?\\b|\\b(?:take|cut|leave|get|kill|lose|drop)\\s+(?:the\\s+)?${DRUM_PARTS}s?\\s+(?:out|away)\\b`,
);
/** Things other than drums that "simpler" or "busier" can be about: those get an answer of their own. */
const NOT_DRUMS = /\b(?:melody|melodies|lead|chords?|pads?|keys|piano|bass|808|vocals?|vox|voice|arp)\b/;
const DRUM_WORDS = /\b(?:drums?|hi-?hats?|hats?|kick|snare|claps?|percussion|perc|beat|rhythm|groove)\b/;
const FILL = /\b(?:fills?|drum fill|snare roll)\b/;
const HAT_ROLL = /\bhat rolls?\b|\broll(?:s)? on the hats?\b|\bhi-?hat rolls?\b|\btrap rolls?\b/;

/** A part a request can take out: the word `vary without` uses for it, what to call it and the roles it is. */
interface TakeOut {
  part: string;
  label: string;
  roles: ReadonlySet<Role>;
}

const TAKE_OUT_WORDS: readonly (readonly [RegExp, TakeOut])[] = [
  [/\b(?:hi-?hats?|hats?)\b/, { part: 'hats', label: 'the hats', roles: HAT_ROLES }],
  [/\bkicks?\b/, { part: 'kick', label: 'the kick', roles: KICK_ROLES }],
  [/\bsnares?\b|\bclaps?\b/, { part: 'snare', label: 'the snare', roles: SNARE_ROLES }],
  [/\bperc(?:ussion)?\b/, { part: 'perc', label: 'the percussion', roles: DRUM_ROLES }],
  [/\b808s?\b/, { part: '808', label: 'the 808', roles: BASS_ROLES }],
  [/\bbass\b/, { part: 'bass', label: 'the bass', roles: BASS_ROLES }],
  [/\bdrums\b/, { part: 'drums', label: 'the drums', roles: DRUM_ROLES }],
];

/** Every part the words take out ("remove the hats and the kick"). */
function partsToTakeOut(text: string): TakeOut[] {
  return TAKE_OUT_WORDS.filter(([word]) => word.test(text)).map(([, part]) => part);
}

/** "Simpler melody", "busier chords": density words about a part this editor does not thin or thicken. */
function densityOfOtherPart(context: RuleContext): RuleResult {
  const word = NOT_DRUMS.exec(context.clause)?.[0] ?? 'that part';
  return {
    reply: `I can make the drums simpler or busier, but not the ${word}. For ${/melod|lead|arp/.test(word) ? 'the melody' : `the ${word}`} I can write a new one instead (for example "new melody for the hook" or "change the chords"), or you can edit it in the piano roll.`,
  };
}

/** "bar 8" or "bars 8, 16 and 24". */
function barList(bars: readonly number[]): string {
  if (bars.length === 1) return `bar ${bars[0]}`;
  return `bars ${bars.slice(0, -1).join(', ')} and ${bars[bars.length - 1]}`;
}

/** Where fills and rolls go: the last bar of each named part, or the end of each section when no part is named. */
function endBars(context: RuleContext): number[] {
  const { scope, facts } = context;
  const bars = scope.isNamed || facts.sections.length === 0
    ? scope.ranges.map((range) => range.toBar)
    : facts.sections.slice(0, -1).map((section) => section.range.toBar);
  return bars.slice(0, MAX_END_ACTIONS);
}

/** The one place a request puts a fill: "at the end" is the end of the song. */
function fillBars(context: RuleContext): number[] {
  if (context.scope.anchor === 'end' && !context.scope.isNamed) return [context.facts.totalBars];
  return endBars(context);
}

function busier(context: RuleContext): RuleResult {
  const { scope, facts, text, amount } = context;
  if (!hasPart(facts, scope.ranges, HAT_ROLES)) return { reply: nothingThereReply('hats', context) };
  const onlyHats = HATS.test(text);
  const actions: OfflineAction[] = scope.ranges.map((range) => varyOver('double_hats', range));
  const rolls = amount === 'large' || !onlyHats;
  if (rolls) for (const bar of endBars(context)) actions.push({ op: 'vary', kind: onlyHats ? 'hat_roll' : 'fill', bar });
  const what = onlyHats ? 'hats' : 'drums';
  return { message: `Made the ${what} busier in ${scope.label}.`, actions };
}

function simpler(context: RuleContext): RuleResult {
  const { scope, facts, amount, text } = context;
  if (!hasPart(facts, scope.ranges, DRUM_ROLES)) return { reply: nothingThereReply('drums', context) };
  // Level 1 only takes out ghost notes and off-beat hats, which a plain groove does not have: "simpler" means level 2.
  const level = byAmount(amount, [1, 2, 2]);
  const actions = scope.ranges.map((range) => varyOver('thin', range, { level }));
  const what = HATS.test(text) ? 'hats' : 'drums';
  return { message: `Made the ${what} simpler in ${scope.label}${level === 2 ? ' (kick, snare and hats on the beat only)' : ''}.`, actions };
}

function partOut(context: RuleContext): RuleResult {
  const { scope, facts, text } = context;
  const wanted = partsToTakeOut(text);
  if (wanted.length === 0) return { reply: 'Say which part to take out (the hats, the kick, the snare, the drums, the 808).' };
  const present = wanted.filter((part) => hasPart(facts, scope.ranges, part.roles));
  const first = wanted[0] as TakeOut;
  if (present.length === 0) return { reply: nothingThereReply(first.label.replace(/^the /, ''), context) };
  const actions = scope.ranges.map((range) => varyOver('without', range, { channels: present.map((part) => part.part) }));
  return { message: `Took ${present.map((part) => part.label).join(' and ')} out of ${scope.label}.`, actions };
}

function fill(context: RuleContext): RuleResult {
  const { scope, facts } = context;
  if (!hasPart(facts, scope.ranges, DRUM_ROLES)) return { reply: nothingThereReply('drums', context) };
  if (!scope.isNamed && scope.anchor !== 'end') {
    // No place named: the arranger's own fills, every 8 bars, through the whole song.
    const action: OfflineAction = { op: 'develop', fills: true, transitions: false, fx: false, cleanup: false };
    return { message: 'Added fills through the song (one every 8 bars, a small change every 4).', actions: [action] };
  }
  const bars = fillBars(context);
  const actions: OfflineAction[] = bars.map((bar) => ({ op: 'vary', kind: 'fill', bar }));
  return { message: `Added ${bars.length === 1 ? 'a fill' : 'fills'} at the end of ${barList(bars)}.`, actions };
}

function hatRoll(context: RuleContext): RuleResult {
  const { scope, facts } = context;
  if (!hasPart(facts, scope.ranges, HAT_ROLES)) return { reply: nothingThereReply('hats', context) };
  const bars = fillBars(context);
  const actions: OfflineAction[] = bars.map((bar) => ({ op: 'vary', kind: 'hat_roll', bar }));
  return { message: `Added ${bars.length === 1 ? 'a hat roll' : 'hat rolls'} at the end of ${barList(bars)}.`, actions };
}

/** Drum edits, most specific first. */
export const DRUM_RULES: readonly Rule[] = [
  { id: 'hat-roll', matches: (text) => HAT_ROLL.test(text) && !SIMPLER.test(text), run: hatRoll },
  { id: 'part-out', matches: (text) => PART_OUT.test(text), run: partOut },
  { id: 'other-part-density', matches: (text) => (SIMPLER.test(text) || BUSIER.test(text)) && NOT_DRUMS.test(text) && !DRUM_WORDS.test(text), run: densityOfOtherPart },
  { id: 'drums-simpler', matches: (text) => SIMPLER.test(text), run: simpler },
  { id: 'drums-busier', matches: (text) => BUSIER.test(text), run: busier },
  // A fill that leads into a part is a transition, which the transitions rules write.
  { id: 'fill', matches: (_text, clause) => FILL.test(clause) && !/\b(?:into|leading into|before)\b/.test(clause), run: fill },
];
