/** Small requests about the song as a whole: undo the last change, tidy the arrangement, and two questions (the key, the tempo). */
import { keyUsesFlats, pitchName } from '../../harmony/chord';
import { harmonyKey } from '../../harmony/key';
import { keyMode } from '../../harmony/scale';
import type { Rule, RuleContext, RuleResult } from '../types';

const UNDO = /^(?:please )?(?:undo|undo (?:that|it|the last (?:thing|change))|take (?:that|it) back|revert (?:that|it)|go back)$/;
const TIDY =
  /\b(?:clean(?:ing)?(?: it)? up|tidy(?: it)?(?: up)?|clean)\b[^.]*\b(?:song|arrangement|playlist|project|stacked|duplicates?|copies)\b|\bremove (?:the )?(?:duplicates?|stacked (?:copies|parts)|doubled parts)\b/;

const ASK_KEY = /\bwhat(?:'s| is)?(?: the)? key\b|\bwhich key\b|\bwhat key\b/;
const ASK_TEMPO = /\bwhat(?:'s| is)?(?: the)? (?:tempo|bpm)\b|\bhow fast (?:is|does)\b/;

function undo(): RuleResult {
  return { message: 'Undid the last change.', actions: [{ op: 'command', id: 'edit.undo' }] };
}

function tidy(): RuleResult {
  return {
    message: 'Tidied the arrangement: stacked copies removed, repeated automation merged, tracks named after what they play.',
    actions: [{ op: 'tidy' }],
  };
}

function tellKey(context: RuleContext): RuleResult {
  const { project, roles } = context.input;
  const key = harmonyKey(project, roles);
  const name = `${pitchName(key.root, keyUsesFlats(key.root, keyMode(key.scale)))} ${key.scale}`;
  if (key.from === 'song') return { reply: `The song key is set to ${name}.` };
  if (key.from === 'notes') return { reply: `No key is set, but the notes sound like ${name}. Say "change the key to ${name}" to set it.` };
  return { reply: 'No key is set and the notes do not say one. Name one to set it, for example "change the key to F minor".' };
}

function tellTempo(context: RuleContext): RuleResult {
  const { bpm, swing } = context.input.project.transport;
  return { reply: `The tempo is ${Math.round(bpm * 10) / 10} BPM${swing > 0 ? ` with ${Math.round(swing * 100)} % swing` : ''}.` };
}

/** Undo. */
export const UNDO_RULES: readonly Rule[] = [{ id: 'undo', matches: (_text, clause) => UNDO.test(clause), run: undo, needsSong: false }];

/** Tidy the arrangement. */
export const TIDY_RULES: readonly Rule[] = [{ id: 'tidy', matches: (_text, clause) => TIDY.test(clause), run: tidy }];

/** Questions about the song's key and tempo. */
export const QUESTION_RULES: readonly Rule[] = [
  { id: 'ask-key', matches: (_text, clause) => ASK_KEY.test(clause), run: tellKey, needsSong: false },
  { id: 'ask-tempo', matches: (_text, clause) => ASK_TEMPO.test(clause), run: tellTempo, needsSong: false },
];
