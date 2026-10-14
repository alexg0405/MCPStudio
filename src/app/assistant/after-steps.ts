/**
 * Follow-up work after an AI answer is applied, that needs time (rendering and measuring): run
 * before the answer's playback starts, folded into the answer's undo step (`history.transact(…,
 * { amend: entry })`). Each kind of after-edit request can have one step.
 */
import type { AfterEdit } from '../ai/apply';
import { levelMixStep } from '../mix/level-step';
import type { Services } from '../services';

export interface AfterStepContext {
  s: Services;
  /** The answer's undo entry (amend it), or null when the answer changed nothing. */
  entry: number | null;
  signal: AbortSignal;
  progress(label: string, fraction: number): void;
}

export interface AfterStepResult {
  /** A line for the chat ("Leveled the mix"). */
  message: string;
  changes?: string[];
  warnings?: string[];
}

export type AfterStep = (item: AfterEdit, c: AfterStepContext) => Promise<AfterStepResult | null>;

const STEPS = new Map<string, AfterStep>();
if (levelMixStep) STEPS.set('level_mix', levelMixStep);

/** Adds (or replaces) the step for a kind of after-edit request; returns a function that removes it. */
export function registerAfterStep(kind: AfterEdit['kind'], run: AfterStep): () => void {
  STEPS.set(kind, run);
  return () => {
    if (STEPS.get(kind) === run) STEPS.delete(kind);
  };
}

export function afterStepFor(kind: AfterEdit['kind']): AfterStep | undefined {
  return STEPS.get(kind);
}
