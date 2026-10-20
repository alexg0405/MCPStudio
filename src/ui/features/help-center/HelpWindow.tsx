import { Fragment, useMemo, useState } from 'react';
import type { WindowContentProps } from '../../workspace/registry';
import { useServices } from '../../services-context';
import { togglePalette } from '../palette/Palette';
import { tourForWindow } from '../tours/tour-list';
import { startTour } from '../tours/tour-state';
import { countByCategory, searchTopics } from './help-search';
import { collectHelpTopics, HELP_CATEGORIES, type HelpCategory, type HelpTopic } from './help-topics';
import styles from './HelpWindow.module.css';

/**
 * What the Help window can be opened with (all optional): `topic` (an id such as "window:mixer"), `query` (words to search
 * for) and `category` (one of the category names, or "all").
 */
export type HelpProps = Record<string, string>;

/** The category a prop names, if it names one. */
function asCategory(value: string | undefined): HelpCategory | 'all' | undefined {
  return value === 'all' || HELP_CATEGORIES.some((c) => c.id === value) ? (value as HelpCategory | 'all') : undefined;
}

/**
 * The Help window: search everything AGstudio explains (tours, lessons, every window's "?" text, every command's hint, the
 * keyboard shortcuts, keyboard navigation and touch gestures), or browse by category. The list is on the left, the topic
 * with its button (start the tour, open the window, run the command) on the right.
 */
export function HelpWindow({ props }: WindowContentProps<HelpProps>) {
  // Opened again with something to show (a "?" link, a command): start over from it.
  const start = props ?? {};
  return <HelpContent key={`${start.topic ?? ''}|${start.query ?? ''}|${start.category ?? ''}`} start={start} />;
}

/** The category to list first: the one asked for, the topic's own, "all" for a search, else the tours. */
function firstCategory(start: HelpProps, topics: readonly HelpTopic[]): HelpCategory | 'all' {
  const asked = asCategory(start.category);
  if (asked) return asked;
  if (start.query) return 'all';
  return topics.find((t) => t.id === start.topic)?.category ?? 'Tours';
}

function HelpContent({ start }: { start: HelpProps }) {
  const services = useServices();
  const topics = useMemo(() => collectHelpTopics(services), [services]);
  const counts = useMemo(() => countByCategory(topics), [topics]);
  const [query, setQuery] = useState(start.query ?? '');
  const [category, setCategory] = useState<HelpCategory | 'all'>(() => firstCategory(start, topics));
  const [selectedId, setSelectedId] = useState<string | null>(start.topic ?? null);

  const results = useMemo(() => searchTopics(topics, query, category), [topics, query, category]);
  const selected = topics.find((t) => t.id === selectedId) ?? results[0] ?? null;

  const onQuery = (text: string) => {
    setQuery(text);
    if (text.trim()) setCategory('all');
    setSelectedId(null);
  };

  return (
    <div className={styles.root} data-tour="help-window">
      <div className={styles.bar}>
        <input
          className={styles.search}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search help: “record a vocal”, “loudness”, “split a clip”…"
          aria-label="Search help"
          data-hint="Type what you want to do or what something is called: tours, windows, commands, shortcuts and gestures are all searched"
          autoFocus
        />
      </div>
      <div className={styles.categories} role="toolbar" aria-label="Help categories" data-roving>
        <CategoryButton
          label="All"
          count={topics.length}
          active={category === 'all'}
          blurb="Search every topic"
          onPick={() => setCategory('all')}
        />
        {HELP_CATEGORIES.map((c) => (
          <CategoryButton
            key={c.id}
            label={c.id}
            count={counts.get(c.id) ?? 0}
            active={category === c.id}
            blurb={c.blurb}
            onPick={() => setCategory(c.id)}
          />
        ))}
      </div>
      <div className={styles.body}>
        <TopicList results={results} selectedId={selected?.id ?? null} query={query} onPick={setSelectedId} />
        <div className={styles.detail}>{selected ? <TopicDetail topic={selected} /> : <NoResults query={query} />}</div>
      </div>
    </div>
  );
}

function CategoryButton(props: { label: string; count: number; active: boolean; blurb: string; onPick(): void }) {
  return (
    <button
      className={`${styles.category} ${props.active ? styles.categoryOn : ''}`}
      aria-pressed={props.active}
      onClick={props.onPick}
      data-hint={props.blurb}
    >
      {props.label} <span className={styles.count}>{props.count}</span>
    </button>
  );
}

/** What a search result is, in one word (the list is mixed, best match first). */
const KIND_LABEL: Record<HelpCategory, string> = {
  Tours: 'Tour',
  Lessons: 'Lesson',
  Windows: 'Window',
  Commands: 'Action',
  Shortcuts: 'Shortcuts',
  'Keyboard navigation': 'Keyboard',
  'Touch and gestures': 'Touch',
};

/** The results, with a small heading each time a command's own category (or a tour's area) changes. */
function TopicList({
  results,
  selectedId,
  query,
  onPick,
}: {
  results: readonly HelpTopic[];
  selectedId: string | null;
  query: string;
  onPick(id: string): void;
}) {
  if (results.length === 0) return <div className={styles.list} aria-label="Help topics" />;
  return (
    <ul
      className={styles.list}
      aria-label={query ? `Help topics matching ${query}` : 'Help topics'}
      data-roving="vertical"
    >
      {results.map((topic, i) => {
        // Browsing a category: a heading each time the group changes. Searching: best match first, so each row says what it is.
        const group = query ? null : topic.group;
        const showGroup = group && (i === 0 || group !== results[i - 1]?.group);
        return (
          <Fragment key={topic.id}>
            {showGroup && (
              <li className={styles.group} role="presentation">
                {group}
              </li>
            )}
            <li>
              <button
                className={`${styles.topic} ${topic.id === selectedId ? styles.topicOn : ''}`}
                aria-current={topic.id === selectedId ? 'true' : undefined}
                onClick={() => onPick(topic.id)}
                data-hint={topic.summary}
              >
                <span className={styles.topicTitle}>{topic.title}</span>
                {query && <span className={styles.topicWhere}>{KIND_LABEL[topic.category]}</span>}
              </button>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

function TopicDetail({ topic }: { topic: HelpTopic }) {
  const services = useServices();
  const windowTour = topic.id.startsWith('window:') ? tourForWindow(topic.id.slice('window:'.length)) : undefined;
  return (
    <article aria-labelledby="ag-help-topic-title">
      <p className={styles.kicker}>{[topic.category, topic.group].filter(Boolean).join(' › ')}</p>
      <h2 id="ag-help-topic-title" className={styles.title}>
        {topic.title}
      </h2>
      <p className={styles.summary}>{topic.summary}</p>
      <div className={styles.actions}>
        {topic.action && (
          <button
            className={`${styles.button} ${styles.primary}`}
            onClick={topic.action.run}
            data-hint={topic.action.label}
          >
            {topic.action.label}
          </button>
        )}
        {windowTour && (
          <button
            className={styles.button}
            onClick={() => void startTour(services, windowTour)}
            data-hint={`${windowTour.summary} (${windowTour.minutes} min, on a demo song)`}
          >
            Take the tour: {windowTour.title}
          </button>
        )}
      </div>
      {topic.moves.length > 0 && (
        <table className={styles.moves}>
          <tbody>
            {topic.moves.map(([how, what], i) => (
              <tr key={`${how}-${i}`}>
                <th scope="row">{how}</th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

/** Nothing matched: say how to search, and hand the words to Studio. */
function NoResults({ query }: { query: string }) {
  return (
    <div className={styles.empty}>
      <p>{query ? `Nothing in Help matches “${query}”.` : 'Pick a topic on the left.'}</p>
      <p>Try fewer or simpler words, or pick a category above.</p>
      {query && (
        <button
          className={styles.button}
          onClick={() => togglePalette(query)}
          data-hint="Open the action search with these words; its last row hands them to Studio"
        >
          Search actions or ask Studio
        </button>
      )}
    </div>
  );
}
