/**
 * The offline edit interpreter: plain words in, the actions an AI's answer would carry out. It reads what the request asks for
 * (one or several things), which part of the song it is about, and each rule turns that into actions on the song as it is. Pure
 * and deterministic: the same words, project and edit count give the same actions, and nothing here changes the project.
 */
import { hashString } from '../arrange/random';
import { parsePrompt } from '../beat/local/prompt';
import { offlineHelpText, unknownRequestReply } from './help';
import { readScope } from './scope';
import { readFacts, describeRange, type SongFacts } from './song-facts';
import { CHORD_RULES } from './rules/chords';
import { DRUM_RULES } from './rules/drums';
import { HIT_RULES } from './rules/hits';
import { QUESTION_RULES, TIDY_RULES, UNDO_RULES } from './rules/housekeeping';
import { KEY_TEMPO_RULES } from './rules/key-tempo';
import { MELODY_RULES } from './rules/melody';
import { MIX_RULES } from './rules/mix';
import { RESTYLE_RULES } from './rules/restyle';
import { STRUCTURE_RULES } from './rules/structure';
import { ELEMENT_RULES, FLOW_RULES } from './rules/transitions';
import { VOCAL_RULES } from './rules/vocals';
import type { BarRange, EditInput, EditOutcome, OfflineAction, Rule, RuleResult, Scope } from './types';
import { amountOf, normalizeWords, splitClauses } from './words';

/**
 * Every rule, in the order they are tried: the first that fits a clause reads it. More specific requests come first ("hit
 * harder" before "louder", a part to add before a fill), so a word that means two things goes to the more particular one.
 */
const RULES: readonly Rule[] = [
  ...UNDO_RULES,
  ...QUESTION_RULES,
  ...VOCAL_RULES,
  ...TIDY_RULES,
  ...KEY_TEMPO_RULES,
  ...STRUCTURE_RULES,
  ...ELEMENT_RULES,
  ...HIT_RULES,
  ...DRUM_RULES,
  ...MELODY_RULES,
  ...CHORD_RULES,
  ...RESTYLE_RULES,
  ...MIX_RULES,
  ...FLOW_RULES,
];

const HELP_WORDS = /^(?:help|help me|what can you do|what do you do|what can i say|what can i ask|how do i use this|commands|what can you do offline|what are you able to do|show me what you can do|\?)$/;
/** Asking for a song or a beat that is new, not a change to this one: "make a sad trap song", "give me a new beat". */
const NEW_MUSIC =
  /\b(?:make|write|create|generate|compose|produce|start|give me|build|do)\b[^.]*\b(?:a|an|another|new|fresh|different)\b[^.]*\b(?:song|track|tune|beat|instrumental|loop)\b/;
/** "A house beat at 124", "a sad trap song": a description that starts with an article and names the music. */
const DESCRIBES_NEW_MUSIC = /^(?:please )?(?:an?|another|new)\s+[\w\s,-]*\b(?:song|track|tune|beat|instrumental|loop)\b/;
const THIS_SONG = /\b(?:the|this|my|our) (?:song|track|tune|beat)\b/;

/** Whether the words ask for a new song or beat instead of a change to the one in the project. */
export function asksForNewMusic(text: string): boolean {
  if (THIS_SONG.test(text)) return false;
  // "boom bap beat with swing": a beat named by its style is a new beat.
  const isStyledBeat = /\b(?:beat|loop|instrumental)\b/.test(text) && parsePrompt(text).style !== undefined;
  return NEW_MUSIC.test(text) || DESCRIBES_NEW_MUSIC.test(text) || isStyledBeat;
}

/** Whether the words read as music to write (a style, a tempo, a key, a beat or song), for requests no rule understood. */
export function readsAsNewMusic(text: string): boolean {
  const info = parsePrompt(text);
  if (info.style !== undefined || info.bpm !== undefined || info.key !== undefined) return true;
  // The section words ("verse", "chorus") are no sign of a new song here: they are how a change names its part.
  return /\b(?:beats?|loops?|groove|rhythm|pattern|instrumental|(?:full|whole|complete) (?:song|track))\b/.test(text.toLowerCase());
}

/** A clause matched to its rule, with the part of the song it is about. */
interface ReadClause {
  clause: string;
  rest: string;
  scope: Scope;
  rule: Rule | null;
  missing: string | null;
}

const sameRange = (a: BarRange, b: BarRange): boolean => a.fromBar === b.fromBar && a.toBar === b.toBar;

/** The sections of the song, for a reply about a part it does not have. */
function sectionList(facts: SongFacts): string {
  if (facts.sections.length === 0) return 'The song has no markers, so name bars instead ("bars 9–16").';
  return `Its parts are ${facts.sections.map((section) => `${section.name} (${describeRange(section.range)})`).join(', ')}.`;
}

/** Reads each clause: its part of the song (a part named in another clause carries over) and the rule that fits it. */
function readClauses(input: EditInput, facts: SongFacts, text: string): ReadClause[] {
  const whole = readScope(text, facts, input.focus);
  return splitClauses(text).map((clause) => {
    const own = readScope(clause, facts, input.focus);
    const inherits = !own.scope.isNamed && whole.scope.isNamed;
    const scope: Scope = inherits ? { ...whole.scope, anchor: own.scope.anchor ?? whole.scope.anchor } : own.scope;
    const rule = RULES.find((candidate) => candidate.matches(own.rest, clause)) ?? null;
    return { clause, rest: own.rest, scope, rule, missing: own.missing };
  });
}

/** Whether the words name the part itself ("in the chorus"), not a place around it ("into the chorus", "before the drop"). */
const isInsideThePart = (scope: Scope): boolean => scope.anchor === null || scope.anchor === 'start' || scope.anchor === 'end';

/** The one span the answer is held to: the part the musician picked, or the one part every clause names (null otherwise). */
function guardFor(input: EditInput, clauses: readonly ReadClause[]): BarRange | null {
  if (input.focus) return input.focus.range;
  const matched = clauses.filter((clause) => clause.rule !== null);
  const isOnePart = (clause: ReadClause) => clause.scope.isNamed && clause.scope.ranges.length === 1 && isInsideThePart(clause.scope);
  if (matched.length === 0 || !matched.every(isOnePart)) return null;
  const first = matched[0]?.scope.ranges[0];
  if (!first) return null;
  return matched.every((clause) => sameRange(clause.scope.ranges[0] as BarRange, first)) ? first : null;
}

/** What to say when nothing applies: the replies of the clauses that could not be done, or that nothing was understood. */
function replyOnly(replies: readonly string[]): EditOutcome {
  return { kind: 'reply', text: replies.join(' ') };
}

/** Reads a request as a change to the song. */
export function interpretEdit(input: EditInput): EditOutcome {
  const text = normalizeWords(input.text);
  if (!text) return { kind: 'none' };
  if (HELP_WORDS.test(text)) return { kind: 'reply', text: offlineHelpText() };
  if (!input.focus && asksForNewMusic(text)) return { kind: 'none' };
  const facts = readFacts(input);
  const clauses = readClauses(input, facts, text);
  const guard = guardFor(input, clauses);
  const actions: OfflineAction[] = [];
  const messages: string[] = [];
  const replies: string[] = [];
  const unread: string[] = [];
  clauses.forEach((read, index) => {
    if (read.missing) {
      replies.push(`There is no ${read.missing} in this song. ${sectionList(facts)}`);
      return;
    }
    if (!read.rule) {
      unread.push(read.clause);
      return;
    }
    if (read.rule.needsSong !== false && facts.totalBars === 0) {
      replies.push('The playlist is empty: there is no song to change yet. Ask for a song first, for example "a sad trap song at 140".');
      return;
    }
    const seed = (hashString(read.clause) + (input.variation + 1) * 7919 + index * 104729) >>> 0;
    const result: RuleResult = read.rule.run({
      input,
      facts,
      text: read.rest,
      clause: read.clause,
      guard,
      scope: read.scope,
      amount: amountOf(read.clause),
      seed,
    });
    if ('reply' in result) replies.push(result.reply);
    else {
      messages.push(result.message);
      actions.push(...result.actions);
    }
  });
  if (actions.length === 0 && replies.length === 0) {
    // Nothing read as an edit: music to write, or words that cannot be read.
    if (!input.focus && readsAsNewMusic(text)) return { kind: 'none' };
    return { kind: 'reply', text: unknownRequestReply() };
  }
  if (actions.length === 0) return replyOnly(replies);
  const left = unread.length > 0 ? [`I did not understand “${unread.join('”, “')}”, so I left that out.`] : [];
  const couldNot = replies.length > 0 ? [`Not done: ${replies.join(' ')}`] : [];
  return { kind: 'edit', message: [...messages, ...couldNot, ...left].join(' '), actions, guard };
}
