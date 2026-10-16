/**
 * The Studio's `filter` action, after the answer: renders the part and applies the filter, folded
 * into the answer's undo step (its own when the answer changed nothing else).
 */
import { findFilter } from '@core/filters/presets';
import { targetLabel } from '@core/filters/target';
import type { AfterStep } from '../assistant/after-steps';
import { applyFilter } from './apply';

export const filterStep: AfterStep = async (item, c) => {
  if (item.kind !== 'filter') return null;
  await c.whenQuiet();
  const name = findFilter(item.filter)?.name ?? item.filter;
  c.progress(`Rendering ${targetLabel(c.s.doc.getState().project, item.target)} for ${name}`, 0);
  const res = await applyFilter(c.s, item.filter, item.target, {
    signal: c.signal,
    ...(c.entry !== null ? { amend: c.entry } : {}),
  });
  c.progress('Done', 1);
  return { message: res.message };
};
