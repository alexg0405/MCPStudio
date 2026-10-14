/**
 * What the AI answers with: a message for the musician and a list of actions on the project. A JSON
 * schema for structured outputs (every object `additionalProperties: false`, ranges in descriptions —
 * structured outputs take no numeric bounds; the applier validates and clamps everything). Each
 * action's schema lives next to its handler in `./ops`.
 */
import { OP_SCHEMAS } from './ops';

export const ACTION_OPS = OP_SCHEMAS;

export const ACTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        'What you did (or your answer), in one to three plain sentences for the musician. If something they asked for is impossible, say so.',
    },
    actions: {
      type: 'array',
      description: 'The edits, in order (empty for questions). They are applied together as one undo step.',
      items: { anyOf: ACTION_OPS },
    },
  },
  required: ['message', 'actions'],
} as const;

/** A param value as the AI sends it. */
export interface ParamEntry {
  name: string;
  value: number | string | boolean;
}

/** One action as received (validated field by field when applied). */
export type AiAction = { op: string } & Record<string, unknown>;

export interface AiAnswer {
  message: string;
  actions: AiAction[];
}

/** Checks the answer's outer shape; drops actions that aren't objects with a known op. */
export function readAnswer(raw: unknown): { answer: AiAnswer; dropped: number } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'the answer is not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.message !== 'string') return { error: 'the answer has no message' };
  if (!Array.isArray(r.actions)) return { error: 'the answer has no actions list' };
  const known = new Set<string>(ACTION_OPS.map((o) => o.properties.op.const));
  const actions = r.actions.filter(
    (a): a is AiAction => typeof a === 'object' && a !== null && known.has((a as { op?: string }).op ?? ''),
  );
  return { answer: { message: r.message.trim(), actions }, dropped: r.actions.length - actions.length };
}
