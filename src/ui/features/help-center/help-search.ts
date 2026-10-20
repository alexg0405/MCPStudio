import { searchActions } from '../palette/search';
import type { ActionEntry } from '../../shell/actions';
import type { HelpCategory, HelpTopic } from './help-topics';

/** A topic as the action search's ranking reads it: the title is the label, the text and the moves are words to match. */
function asEntry(topic: HelpTopic): ActionEntry {
  const words = [...topic.keywords, ...topic.moves.flat()];
  return {
    key: topic.id,
    label: topic.title,
    path: topic.group ? [topic.category, topic.group] : [topic.category],
    hint: topic.summary,
    keywords: words,
    run: () => {},
  };
}

/**
 * The topics that match `query`, best first, optionally only one category. Every word of the query has to match; the title
 * counts most, then the keywords and the text of its moves (the same ranking, with the same newcomer synonyms, as the action
 * search). With no query a category lists its topics in their own order (commands by group and title).
 */
export function searchTopics(
  topics: readonly HelpTopic[],
  query: string,
  category: HelpCategory | 'all' = 'all',
): HelpTopic[] {
  const inCategory = category === 'all' ? topics : topics.filter((t) => t.category === category);
  if (!query.trim()) {
    return category === 'Commands'
      ? [...inCategory].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.title.localeCompare(b.title))
      : [...inCategory];
  }
  const byId = new Map(inCategory.map((t) => [t.id, t]));
  return searchActions(inCategory.map(asEntry), query)
    .map((entry) => byId.get(entry.key))
    .filter((t): t is HelpTopic => t !== undefined);
}

/** How many topics each category holds (the Help window's category buttons show it). */
export function countByCategory(topics: readonly HelpTopic[]): Map<HelpCategory, number> {
  const counts = new Map<HelpCategory, number>();
  for (const t of topics) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return counts;
}
