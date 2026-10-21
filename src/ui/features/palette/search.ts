/**
 * Ranking for the action search (Mod+K). Pure: entries come from menus, commands and providers.
 * Every query word has to match somewhere (label, menu path, hint or keywords); matches at the start
 * of a word count more, the label counts most, and recently used actions float up.
 */
import { normalizeText, prepareEntry, wordScore } from '@core/search/rank';
import type { ActionEntry } from '../../shell/actions';

export type { ActionEntry };

/** Entries matching `query`, best first. An empty query lists recent actions first, then everything. */
export function searchActions(entries: readonly ActionEntry[], query: string, recent: readonly string[] = []): ActionEntry[] {
  const rank = new Map(recent.map((k, i) => [k, i]));
  const recency = (e: ActionEntry) => {
    const i = rank.get(e.key);
    return i === undefined ? 0 : Math.max(0, 6 - i * 0.5);
  };
  const q = normalizeText(query);
  if (!q) {
    return [...entries].sort((a, b) => {
      const ra = rank.get(a.key) ?? Infinity;
      const rb = rank.get(b.key) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.path.join(' ').localeCompare(b.path.join(' ')) || a.label.localeCompare(b.label);
    });
  }
  const words = q.split(/\s+/);
  const scored: { entry: ActionEntry; score: number }[] = [];
  for (const entry of entries) {
    const parts = prepareEntry(entry);
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = wordScore(parts, w);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (parts.label === q) score += 20;
    score += recency(entry) + (entry.boost ?? 0);
    if (entry.disabled) score -= 4;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.map((s) => s.entry);
}

/** Keeps the recent-actions list short, most recent first. */
export function pushRecent(recent: readonly string[], key: string, max = 20): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, max);
}
