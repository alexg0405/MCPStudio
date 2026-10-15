/**
 * The "level the mix" step after an AI answer that built or rearranged a song: renders the busiest
 * part, measures each bus and sets the faders and the master limiter to the style's targets
 * (`auto-level.ts`), folded into the answer's undo step. Registered for the `level_mix` after-edit.
 */
import type { InsertId } from '@core/model/types';
import type { AfterEdit } from '../ai/apply';
import type { AfterStep } from '../assistant/after-steps';
import { autoLevel } from './auto-level';

/**
 * The mixer tracks whose faders the AI set in the answer that asked for leveling (auto-level leaves
 * them alone), by its after-edit request (filled in by the mix actions' `beforeCommit`).
 */
export const pinnedFor = new WeakMap<AfterEdit, ReadonlySet<InsertId>>();

export const levelMixStep: AfterStep | null = async (item, c) => {
  if (item.kind !== 'level_mix') return null;
  const pinned = pinnedFor.get(item);
  const res = await autoLevel(c.s, {
    style: item.style,
    ...(item.fromTick !== undefined ? { fromTick: item.fromTick } : {}),
    ...(item.bars !== undefined ? { bars: item.bars } : {}),
    ...(pinned ? { pinned } : {}),
    entry: c.entry,
    signal: c.signal,
    progress: c.progress,
    whenQuiet: c.whenQuiet,
  });
  if (!res) return { message: 'There was nothing to level: the song has no role buses yet (set up the mix first).' };
  return { message: res.message, changes: res.changes, ...(res.warnings.length ? { warnings: res.warnings } : {}) };
};
