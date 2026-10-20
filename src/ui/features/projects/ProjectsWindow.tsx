import { memo, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { plural } from '@core/gc/format';
import { filterProjects, PROJECT_SORTS, sortProjects, type ListedProject, type ProjectSort } from '@core/projects/list';
import { formatLength } from '@core/versions/facts';
import { formatAgo } from '@core/versions/time';
import { subscribeRecentFiles } from '@app/persistence/recent-files';
import { showContextMenu } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { ProjectThumbnail } from './ProjectThumbnail';
import styles from './Projects.module.css';

/** How often the list is read again while the window is open (ms): other tabs and autosaves change what is there. */
const REFRESH_EVERY_MS = 20_000;

/** "128 BPM · A minor · 2:05 · 64 bars", or what is known of it. */
function describeFacts(item: ListedProject): string {
  const facts = item.facts;
  if (!facts) return 'Open it once to see its tempo and length here';
  const parts = [`${facts.bpm} BPM`];
  if (facts.key) parts.push(facts.key);
  if (facts.bars > 0) parts.push(`${formatLength(facts.lengthSec)} · ${plural(facts.bars, 'bar')}`);
  else parts.push('nothing on the playlist yet');
  return parts.join(' · ');
}

/** Where the project is kept, in plain words. */
function describeSource(item: ListedProject): string {
  if (item.source === 'file') return 'In a file';
  if (item.source === 'autosave') return 'Autosaved work (not saved to a file)';
  return 'Kept as versions (no file)';
}

interface CardProps {
  item: ListedProject;
  now: number;
}

const ProjectCard = memo(function ProjectCard({ item, now }: CardProps) {
  const s = useServices();
  const open = () => void s.projects.open(item);
  const openCopy = () => void s.projects.openCopy(item);
  const showVersions = () => {
    void s.projects.showVersions(item).then(() => openWindow(s, 'versions'));
  };
  const togglePin = () => void s.projects.setPinned(item, !item.pinned);
  const remove = () => {
    void s.projects.removeFromList(item).then(() => s.session.getState().toast(`Removed “${item.name}” from the list. Its file and versions are untouched.`));
  };
  const canPin = !!item.projectId;
  const canShowVersions = item.isOpen || item.versionCount > 0;
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    showContextMenu(event, [
      { label: 'Open', disabled: item.isOpen, onSelect: open },
      { label: 'Open a copy', hint: 'Open the same song as a new unsaved project; the original is not touched', onSelect: openCopy },
      { label: 'Show versions', disabled: !canShowVersions, hint: 'List the save points of this project', onSelect: showVersions },
      { kind: 'separator' },
      { label: item.pinned ? 'Unpin' : 'Pin to the top', disabled: !canPin, onSelect: togglePin },
      { label: 'Remove from list', hint: 'Takes it off this list only: the file, its autosaves and its versions stay', onSelect: remove },
    ]);
  };
  return (
    <li className={`${styles.card} ${item.isOpen ? styles.current : ''}`} onContextMenu={openMenu}>
      <button
        className={styles.picture}
        onClick={open}
        disabled={item.isOpen}
        aria-label={item.isOpen ? `${item.name} is open now` : `Open ${item.name}`}
        data-hint={item.isOpen ? 'This is the project you have open' : `Open “${item.name}”`}
      >
        <ProjectThumbnail thumbnail={item.thumbnail} label={item.name} />
      </button>
      <div className={styles.nameRow}>
        <span className={styles.name} title={item.name}>
          {item.name}
        </span>
        <button
          className={styles.pin}
          aria-pressed={item.pinned}
          aria-label={item.pinned ? `Unpin ${item.name}` : `Pin ${item.name} to the top`}
          disabled={!canPin}
          onClick={togglePin}
          data-hint={item.pinned ? 'Pinned: it stays at the top of the list. Click to unpin' : 'Pin this project to the top of the list'}
        >
          {item.pinned ? '★' : '☆'}
        </button>
      </div>
      <div className={styles.meta}>{describeFacts(item)}</div>
      <div className={styles.when}>
        {describeSource(item)} · opened {formatAgo(item.lastOpenedAt, now)}
      </div>
      <div className={styles.badges}>
        {item.isOpen && <span className={`${styles.badge} ${styles.badgeOn}`}>open now</span>}
        {item.hasUnsavedWork && <span className={`${styles.badge} ${styles.badgeOn}`}>unsaved changes</span>}
        {item.versionCount > 0 && <span className={styles.badge}>{plural(item.versionCount, 'version')}</span>}
      </div>
      <div className={styles.actions}>
        <button className={styles.small} disabled={item.isOpen} onClick={open} data-hint="Open this project (it asks about unsaved changes in the current one first)">
          Open
        </button>
        <button className={styles.small} onClick={openCopy} data-hint="Open the same song as a new unsaved project; the original and its versions are not touched">
          Open a copy
        </button>
        <button className={styles.small} disabled={!canShowVersions} onClick={showVersions} data-hint="List the save points of this project: listen to one, restore it or open it as a copy">
          Versions
        </button>
        <button className={styles.small} onClick={remove} aria-label={`Remove ${item.name} from the list`} data-hint="Take this project off the list. The file, its autosaves and its versions are not deleted">
          Remove
        </button>
      </div>
    </li>
  );
});

/** The project list: reads on opening, when files are remembered, and every so often while open. */
function useProjectList(): { items: ListedProject[]; isLoading: boolean } {
  const s = useServices();
  const view = useStore(s.projects.view);
  useEffect(() => {
    const refresh = () => void s.projects.refresh();
    refresh();
    const offRecent = subscribeRecentFiles(refresh);
    const offFiles = s.files.store.subscribe((state, previous) => {
      if (state.name !== previous.name || state.fileKey !== previous.fileKey) refresh();
    });
    const offVersions = s.versions.view.subscribe((state, previous) => {
      if (state.versions !== previous.versions) refresh();
    });
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_EVERY_MS);
    return () => {
      offRecent();
      offFiles();
      offVersions();
      clearInterval(timer);
    };
  }, [s]);
  return view;
}

/**
 * Your projects: the files AGstudio remembers, work it autosaved and projects that have versions, each with its tempo,
 * key, length and a small picture of the arrangement. Search, sort, pin, open, open a copy, see the versions.
 */
export function ProjectsWindow() {
  const s = useServices();
  const { items, isLoading } = useProjectList();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const shown = useMemo(() => sortProjects(filterProjects(items, query), sort), [items, query, sort]);

  return (
    <div className={styles.wrap}>
      <div className={styles.help}>
        Every project AGstudio remembers, newest first. Open one, open a copy to try something without risk, or see its versions. Nothing here is deleted by taking it off the list.
      </div>
      <div className={styles.bar}>
        <input
          className={styles.search}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search by name, key or tempo"
          aria-label="Search projects"
          data-hint="Type part of a name, a key (“A minor”) or a tempo (“128 bpm”)"
        />
        <select
          className={styles.select}
          value={sort}
          onChange={(event) => setSort(event.currentTarget.value as ProjectSort)}
          aria-label="Sort projects by"
          data-hint="Order the list. Pinned projects always stay at the top"
        >
          {PROJECT_SORTS.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <button className={styles.button} onClick={() => void s.commands.run('file.open')} data-hint="Open a project file from your computer">
          Open file…
        </button>
        <button className={`${styles.button} ${styles.primary}`} onClick={() => void s.commands.run('file.new')} data-hint="Start a new project from the default template">
          New project
        </button>
      </div>
      {shown.length === 0 ? (
        <div className={styles.empty}>
          {isLoading ? (
            'Looking for your projects…'
          ) : items.length === 0 ? (
            <>
              <b>No projects yet.</b>
              <p>Save your song with File → Save and it is listed here with its tempo, key and a picture of the arrangement. Projects you open also appear here.</p>
            </>
          ) : (
            <>
              <b>No project matches “{query}”.</b>
              <p>Try fewer words, or clear the search.</p>
            </>
          )}
        </div>
      ) : (
        <ul className={styles.grid} aria-label="Projects">
          {shown.map((item) => (
            <ProjectCard key={item.id} item={item} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
