/** The MCP tools for the undo history: undo, redo and history. */
import type { Services } from '../services';
import { clientLabel, fail, int, ok, type Args, type ToolFn } from './common';

/** The most steps one undo or redo call may take, and how many history lines `history` lists at most. */
const MAX_UNDO_STEPS = 50;
const MAX_HISTORY_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 20;

/** How many steps an undo or redo call asked for (1 when it did not say). */
function stepCount(args: Args): number {
  return Math.min(MAX_UNDO_STEPS, Math.max(1, int(args.steps) ?? 1));
}

/** Undoes back to a history point (0 is the very start); returns the labels undone, or an error text. */
function undoToPoint(s: Services, point: number): string[] | string {
  const done = s.history.steps().done;
  const index = point === 0 ? -1 : done.findIndex((step) => step.id === point);
  if (point !== 0 && index < 0) {
    return `History point ${point} isn't in the undo history any more (it was undone already, or too old). See history.`;
  }
  const labels = done.slice(index + 1).map((step) => step.label);
  s.history.goTo(point);
  return labels;
}

/** Undoes up to `count` steps one by one; returns the labels of the steps that were undone. */
function undoSteps(s: Services, count: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const label = s.history.status().undoLabel;
    if (!s.history.undo()) break;
    if (label) labels.push(label);
  }
  return labels;
}

const undo: ToolFn = async (s, args, ctx) => {
  const client = clientLabel(ctx.client);
  const point = int(args.to_point);
  const undone = point !== undefined ? undoToPoint(s, point) : undoSteps(s, stepCount(args));
  if (typeof undone === 'string') return fail(undone);
  if (undone.length === 0) return fail('Nothing to undo.');
  const labels = undone;
  const newestFirst = labels.slice().reverse().join('; ');
  (await s.assistant.load()).reportExternal(client, `undid: ${newestFirst}`);
  const now = s.history.status();
  const nextText = now.undoLabel ? ` Next undo would revert "${now.undoLabel}".` : '';
  return ok(`Undid ${labels.length} step${labels.length === 1 ? '' : 's'}: ${newestFirst}.${nextText}`, {
    undone: labels.length,
    can_undo: now.canUndo,
    can_redo: now.canRedo,
  });
};

const redo: ToolFn = async (s, args, ctx) => {
  const labels: string[] = [];
  for (let i = 0; i < stepCount(args); i++) {
    const label = s.history.status().redoLabel;
    if (!s.history.redo()) break;
    if (label) labels.push(label);
  }
  if (labels.length === 0) return fail('Nothing to redo.');
  (await s.assistant.load()).reportExternal(clientLabel(ctx.client), `redid: ${labels.join('; ')}`);
  return ok(`Redid ${labels.length} step${labels.length === 1 ? '' : 's'}: ${labels.join('; ')}.`, { redone: labels.length });
};

const history: ToolFn = (s, args) => {
  const limit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, int(args.limit) ?? DEFAULT_HISTORY_LIMIT));
  const { done, undone } = s.history.steps();
  const recent = done.slice(-limit);
  const line = (step: { id: number; label: string }) => `- ${step.label} (point ${step.id})`;
  const doneHeading = recent.length
    ? `Done, oldest first${done.length > recent.length ? ` (last ${recent.length} of ${done.length})` : ''}:`
    : 'Nothing done yet.';
  const lines = [
    doneHeading,
    ...recent.map(line),
    ...(undone.length ? ['Undone (redo brings back the first):', ...undone.slice(0, limit).map(line)] : []),
  ];
  const asData = (step: { id: number; label: string }) => ({ point: step.id, label: step.label });
  return ok(lines.join('\n'), { done: recent.map(asData), undone: undone.slice(0, limit).map(asData) });
};

/** The history tools by their MCP names; `undo` and `redo` change the project, so the caller runs them one at a time. */
export const HISTORY_TOOLS = { undo, redo, history } satisfies Record<string, ToolFn>;
