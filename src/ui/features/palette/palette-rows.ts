/** The rows the action search shows for a query: the matching actions, then "Ask Studio" as a last resort (or the only choice). */
import type { Services } from '@app/services';
import type { ActionEntry } from '../../shell/actions';
import { openWindow } from '../../workspace/registry';
import { searchActions } from './search';

/** The most actions listed (the Ask Studio row comes after them). */
export const MAX_ROWS = 80;

/** Hands the words to the AI studio: it opens and does it (one undoable change). */
function askAi(s: Services, text: string): void {
  openWindow(s, 'assistant');
  if (s.assistant.store.getState().phase !== 'idle') {
    s.session.getState().toast('Studio is still working on your last request.');
    return;
  }
  void s.assistant.send(text);
}

/**
 * The rows for a query: the best matches (the recent ones first when the box is empty), and "Ask Studio: …" after them.
 * When nothing matches, asking the AI is the best bet, so it comes first (and alone).
 */
export function paletteRows(services: Services, entries: readonly ActionEntry[], query: string, recent: readonly string[]): ActionEntry[] {
  const found = searchActions(entries, query, recent).slice(0, MAX_ROWS);
  const text = query.trim();
  if (!text) return found;
  const ask: ActionEntry = {
    key: 'ai',
    label: `Ask Studio: “${text}”`,
    path: ['Studio'],
    hint: 'The AI does it for you in Studio. Every change it makes can be undone.',
    run: () => askAi(services, text),
  };
  return found.length === 0 ? [ask] : [...found, ask];
}
