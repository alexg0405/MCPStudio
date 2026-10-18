/**
 * The Studio's sample work after an answer is applied (place_sample, make_kit): the files are read and their audio stored,
 * then the sounds are put in the project inside the answer's undo step.
 */
import type { AfterStep } from '../assistant/after-steps';
import { runSampleWork } from './work';

export const samplesStep: AfterStep = async (item, c) => {
  if (item.kind !== 'samples') return null;
  c.progress('Reading your samples…', 0);
  const res = await runSampleWork(c.s, item.work, c.entry);
  return {
    message: res.changes.length ? (res.changes.at(-1) as string) : 'No sample was placed',
    changes: res.changes,
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
  };
};
