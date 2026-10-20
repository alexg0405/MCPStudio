/**
 * Putting a whole earlier state of the project back (restoring a version) as one edit. It changes only what differs: a
 * restore that touches a few clips leaves every other object of the document as it was, so the undo step stays small and
 * the engine only reconciles what moved.
 */
import type { Draft } from 'immer';
import type { Project } from '../model/types';

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural equality of plain data, quick when both sides are the same object. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && sameData(left[key], right[key]));
}

/**
 * Makes `node` (a draft of `base`) hold what `target` holds. Objects are compared key by key, so unchanged branches stay
 * the very same objects; arrays and values that differ are replaced whole.
 */
function mergeInto(node: Plain, base: Plain, target: Plain): void {
  for (const key of Object.keys(base)) if (!(key in target)) delete node[key];
  for (const key of Object.keys(target)) {
    const was = base[key];
    const is = target[key];
    if (sameData(was, is)) continue;
    if (isPlain(was) && isPlain(is)) mergeInto(node[key] as Plain, was, is);
    else node[key] = is;
  }
}

/**
 * Inside a recipe: makes the document equal `target`. `base` is the project the recipe started from (what the draft is
 * a copy of). The project keeps its own `projectId`: a restore changes the song, never whose song it is.
 */
export function restoreProject(draft: Draft<Project>, base: Project, target: Project): void {
  mergeInto(draft as unknown as Plain, base as unknown as Plain, { ...target, projectId: base.projectId } as unknown as Plain);
}
