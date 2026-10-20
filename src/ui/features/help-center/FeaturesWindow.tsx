import { useMemo, useState } from 'react';
import { useServices } from '../../services-context';
import type { ActionEntry } from '../../shell/actions';
import { searchActions } from '../palette/search';
import { allFeatureEntries, buildFeatureMap, type FeatureArea, type FeatureEntry } from './feature-map';
import styles from './FeaturesWindow.module.css';

/** What each kind of entry says on its button. */
const VERB: Record<FeatureEntry['kind'], string> = { window: 'Open', tour: 'Start', command: 'Run' };

/** The entries of an area that match the search (all of them with no search). */
function visibleEntries(entries: readonly FeatureEntry[], matching: ReadonlySet<string> | null): FeatureEntry[] {
  return matching ? entries.filter((e) => matching.has(e.id)) : [...entries];
}

/**
 * The Features page: everything AGstudio can do, by area, each with a button that starts it right now and the menu it lives
 * in. It is built from the registered windows, commands and tours (`feature-map.ts`), so it cannot go out of date.
 */
export function FeaturesWindow() {
  const services = useServices();
  const areas = useMemo(() => buildFeatureMap(services), [services]);
  const [query, setQuery] = useState('');
  const matching = useMemo(() => {
    if (!query.trim()) return null;
    const entries: ActionEntry[] = allFeatureEntries(areas).map((e) => ({
      key: e.id,
      label: e.label,
      path: [e.where],
      hint: e.hint,
      run: () => {},
    }));
    return new Set(searchActions(entries, query).map((e) => e.key));
  }, [areas, query]);

  const shown = areas
    .map((area) => ({
      area,
      windows: visibleEntries(area.windows, matching),
      tours: visibleEntries(area.tours, matching),
      commands: visibleEntries(area.commands, matching),
    }))
    .filter((a) => a.windows.length + a.tours.length + a.commands.length > 0);

  return (
    <div className={styles.root} data-tour="features-window">
      <div className={styles.bar}>
        <input
          className={styles.search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a feature: “harmonies”, “loudness”, “video”…"
          aria-label="Search features"
          data-hint="Type a word to show only the features that match; the buttons start them right away"
          autoFocus
        />
      </div>
      <div className={styles.areas}>
        {shown.map(({ area, windows, tours, commands }) => (
          <AreaCard
            key={area.id}
            area={area}
            windows={windows}
            tours={tours}
            commands={commands}
            isSearching={matching !== null}
          />
        ))}
        {shown.length === 0 && (
          <p className={styles.empty}>
            No feature matches “{query}”. Try one word, or ask Studio (the action search’s last row).
          </p>
        )}
      </div>
    </div>
  );
}

function AreaCard(props: {
  area: FeatureArea;
  windows: FeatureEntry[];
  tours: FeatureEntry[];
  commands: FeatureEntry[];
  isSearching: boolean;
}) {
  const { area, windows, tours, commands, isSearching } = props;
  return (
    <section className={styles.card} aria-labelledby={`ag-feature-${area.id}`}>
      <h3 id={`ag-feature-${area.id}`} className={styles.cardTitle}>
        {area.title}
      </h3>
      <p className={styles.cardSummary}>{area.summary}</p>
      {(windows.length > 0 || tours.length > 0) && (
        <div className={styles.entryRow}>
          {windows.map((e) => (
            <EntryButton key={e.id} entry={e} />
          ))}
          {tours.map((e) => (
            <EntryButton key={e.id} entry={e} />
          ))}
        </div>
      )}
      {commands.length > 0 && (
        <details className={styles.commands} open={isSearching || undefined}>
          <summary>
            {commands.length} {commands.length === 1 ? 'action' : 'actions'}
          </summary>
          <ul className={styles.commandList}>
            {commands.map((e) => (
              <CommandRow key={e.id} entry={e} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** A window or a tour: a button with its name. */
function EntryButton({ entry }: { entry: FeatureEntry }) {
  return (
    <button
      className={`${styles.entry} ${entry.kind === 'tour' ? styles.entryTour : ''}`}
      onClick={entry.run}
      disabled={!entry.run}
      data-hint={`${entry.hint} (${entry.where})`}
    >
      {entry.kind === 'tour' ? `Tour: ${entry.label}` : entry.label}
    </button>
  );
}

/** A command: its name, where it is in the menus, its shortcut and a button to run it. */
function CommandRow({ entry }: { entry: FeatureEntry }) {
  return (
    <li className={styles.commandRow}>
      <span className={styles.commandText} data-hint={entry.hint}>
        <span className={styles.commandName}>{entry.label}</span>
        <span className={styles.commandWhere}>{entry.where}</span>
      </span>
      {entry.chord && <kbd className={styles.chord}>{entry.chord}</kbd>}
      <button
        className={styles.run}
        onClick={entry.run}
        disabled={!entry.run}
        data-hint={entry.run ? `${VERB[entry.kind]}: ${entry.hint}` : 'This one is used from a menu, a key or Studio'}
        aria-label={`${VERB[entry.kind]} ${entry.label}`}
      >
        {VERB[entry.kind]}
      </button>
    </li>
  );
}
