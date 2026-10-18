/**
 * The Studio's `dj_mix` after an answer, when some songs still need analyzing: analyzes them (with
 * progress), then plans and writes the mix into the answer's undo step (or its own).
 */
import type { AfterStep } from '../assistant/after-steps';
import { library } from './library';
import { makeMix } from './mix';

/** The Studio's answer step that makes a DJ mix from the songs it asked for. */
export const djMixStep: AfterStep = async (item, c) => {
  if (item.kind !== 'dj_mix') return null;
  library.setState({ making: { label: 'Analyzing the songs…', fraction: 0 } });
  try {
    const res = await makeMix(c.s, item.songs, item.options, {
      signal: c.signal,
      ...(c.entry !== null ? { amend: c.entry } : {}),
      onProgress: (p) => {
        const fraction = (p.index + p.fraction) / p.count;
        c.progress(`Analyzing “${p.title}” (${p.index + 1} of ${p.count})`, fraction);
        library.setState({ making: { label: `Analyzing “${p.title}” (${p.index + 1} of ${p.count})`, fraction } });
      },
    });
    return { message: res.changes.at(-1) ?? 'Made the mix', changes: res.changes, ...(res.warnings.length ? { warnings: res.warnings } : {}) };
  } finally {
    library.setState({ making: null });
  }
};
