import { memo, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { formatSize, plural } from '@core/gc/format';
import { clockTime, dayHeading, formatAgo, localDay } from '@core/versions/time';
import { versionTitle, type VersionRecord } from '@core/versions/types';
import { EVERY_MINUTES_CHOICES } from '@app/versions/settings';
import type { Services } from '@app/services';
import { showContextMenu } from '../../controls/ContextMenu';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';
import { useDoc, useServices } from '../../services-context';
import styles from './Versions.module.css';

/** How often "3 min ago" is recomputed while the window is open (ms). */
const CLOCK_TICK_MS = 15_000;

/** The local time zone, east positive (what the timeline's days are counted in). */
const utcOffsetMinutes = () => -new Date().getTimezoneOffset();

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Asks for a new name; resolves null when cancelled. */
async function askName(title: string, message: string, current: string, okLabel: string): Promise<string | null> {
  const values = await showFormDialog({
    title,
    message,
    fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'Before vocals' }],
    values: { name: current },
    okLabel,
  });
  return values ? String(values.name).trim() : null;
}

/** Deleting a version that was pinned or named asks first: it was kept on purpose. */
async function confirmDelete(record: VersionRecord): Promise<boolean> {
  if (!record.pinned) return true;
  const choice = await showDialog({
    title: 'Delete this version?',
    message: `“${versionTitle(record)}” is kept forever. Delete it anyway?`,
    detail: 'The song as it is now is not touched. This version cannot be brought back.',
    buttons: [
      { id: 'cancel', label: 'Keep it' },
      { id: 'delete', label: 'Delete', danger: true },
    ],
    cancelId: 'cancel',
  });
  return choice === 'delete';
}

/** What changed in the open project since a version, worked out when the row is opened. */
function ChangesSince({ record, isOtherProject }: { record: VersionRecord; isOtherProject: boolean }) {
  const s = useServices();
  const [worked, setWorked] = useState<string[] | null>(null);
  useEffect(() => {
    if (isOtherProject) return;
    let isCurrent = true;
    void s.versions.changesSince(record).then((changes) => isCurrent && setWorked(changes.lines));
    return () => {
      isCurrent = false;
    };
  }, [s, record, isOtherProject]);
  // Another project is not the open song, so all there is to say is what its own version changed.
  const lines = isOtherProject ? record.changes : worked;
  if (lines === null) return <div className={styles.same}>Working out what is different…</div>;
  if (lines.length === 0) return <div className={styles.same}>The song is the same as this version.</div>;
  return (
    <ul className={styles.diff} aria-label="What changed since this version">
      {lines.slice(0, 40).map((line, i) => (
        <li key={i}>{line}</li>
      ))}
      {lines.length > 40 && <li>…and {lines.length - 40} more</li>}
    </ul>
  );
}

interface RowProps {
  record: VersionRecord;
  isOtherProject: boolean;
  isOpen: boolean;
  isPreviewing: boolean;
  isBusy: boolean;
  now: number;
  onToggle(id: string): void;
}

const VersionRow = memo(function VersionRow({ record, isOtherProject, isOpen, isPreviewing, isBusy, now, onToggle }: RowProps) {
  const s = useServices();
  const title = versionTitle(record);
  const when = `${formatAgo(record.createdAt, now)} · ${clockTime(record.createdAt, utcOffsetMinutes())}`;

  const rename = async () => {
    const name = await askName('Rename version', 'Give this version a name so you can find it. A named version is kept forever.', record.name ?? '', 'Rename');
    if (name !== null) await s.versions.rename(record, name);
  };
  const remove = async () => {
    if (await confirmDelete(record)) await s.versions.remove(record);
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    showContextMenu(event, [
      { label: 'Listen', hint: 'Play the start of this version without opening it', onSelect: () => void s.versions.preview(record) },
      {
        label: 'Restore',
        hint: 'Put the song back to this version (one undo step)',
        disabled: isOtherProject,
        onSelect: () => void s.versions.restore(record),
      },
      { label: 'Open as a copy', hint: 'Open this version as a new project and leave the current song alone', onSelect: () => void s.versions.openAsCopy(record) },
      { kind: 'separator' },
      { label: 'What changed since then', onSelect: () => onToggle(record.id) },
      { label: 'Rename…', onSelect: () => void rename() },
      {
        label: record.pinned ? 'Stop keeping it forever' : 'Keep forever',
        hint: record.pinned ? 'Let old versions be tidied away like the others' : 'Never tidy this version away',
        onSelect: () => void s.versions.setPinned(record, !record.pinned),
      },
      { kind: 'separator' },
      { label: 'Delete', danger: true, onSelect: () => void remove() },
    ]);
  };

  return (
    <li className={`${styles.row} ${record.pinned ? styles.pinned : ''} ${record.name ? styles.named : ''} ${isOpen ? styles.open : ''}`} onContextMenu={openMenu}>
      <span className={styles.dot} />
      <div className={styles.top}>
        <div className={styles.label}>
          <span className={styles.name} title={title}>
            {title}
          </span>
          <span className={styles.when}>{when}</span>
        </div>
        {record.pinned && (
          <span className={styles.pin} data-hint="Kept forever: it is never tidied away" aria-label="Kept forever" role="img">
            ★
          </span>
        )}
        <button
          className={styles.small}
          disabled={isBusy && !isPreviewing}
          onClick={() => void s.versions.preview(record)}
          data-hint={isPreviewing ? 'Stop the preview' : 'Play the first 20 seconds of this version without opening it. The song you are working on is not touched'}
        >
          {isPreviewing ? 'Stop' : isBusy ? 'Rendering…' : 'Listen'}
        </button>
        {isOtherProject ? (
          <button className={styles.small} disabled={isBusy} onClick={() => void s.versions.openAsCopy(record)} data-hint="Open this version as a new project (it asks about unsaved changes first)">
            Open copy
          </button>
        ) : (
          <button className={styles.small} disabled={isBusy} onClick={() => void s.versions.restore(record)} data-hint="Put the song back to this version: one undo step, and the song as it is now is kept as a version first">
            Restore
          </button>
        )}
        <button className={styles.small} onClick={openMenu} aria-label={`More for ${title}`} data-hint="Open as a copy, rename, keep forever, what changed since then, delete">
          ⋯
        </button>
      </div>
      <div className={styles.summary}>{record.summary}</div>
      <button className={`${styles.small} ${styles.expand}`} aria-expanded={isOpen} onClick={() => onToggle(record.id)} data-hint="What is different between this version and the song now">
        {isOpen ? 'Hide what changed since then' : 'What changed since then'}
      </button>
      {isOpen && <ChangesSince record={record} isOtherProject={isOtherProject} />}
    </li>
  );
});

/** Groups newest-first versions under the day they were made. */
function byDay(versions: readonly VersionRecord[], now: number): Array<{ heading: string; versions: VersionRecord[] }> {
  const offset = utcOffsetMinutes();
  const groups: Array<{ day: number; heading: string; versions: VersionRecord[] }> = [];
  for (const version of versions) {
    const day = localDay(version.createdAt, offset);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.versions.push(version);
    else groups.push({ day, heading: dayHeading(version.createdAt, now, offset), versions: [version] });
  }
  return groups;
}

function SavePointSettings({ services }: { services: Services }) {
  const settings = useStore(services.versions.settings);
  return (
    <>
      <label className={styles.check} data-hint="Make save points by itself: when you save, every few minutes of editing, before big changes and when you close the tab">
        <input
          type="checkbox"
          checked={settings.isAutomatic}
          onChange={(event) => services.versions.settings.setState({ isAutomatic: event.currentTarget.checked })}
        />
        Save points by themselves
      </label>
      <label className={styles.check} data-hint="Minutes of editing between two automatic save points (a save, a big change or closing the tab also makes one)">
        every
        <select
          className={styles.select}
          value={settings.everyMinutes}
          disabled={!settings.isAutomatic}
          onChange={(event) => services.versions.settings.setState({ everyMinutes: Number(event.currentTarget.value) })}
        >
          {EVERY_MINUTES_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} min
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function Footer({ services, isOtherProject }: { services: Services; isOtherProject: boolean }) {
  const view = useStore(services.versions.view);
  const { project, all } = view.usage;
  const projectId = view.projectId ?? services.doc.getState().project.projectId;
  const remove = async () => {
    const choice = await showDialog({
      title: 'Delete all versions of this project?',
      message: `${plural(project.count, 'version')} (${formatSize(project.bytes)}) will be deleted, including the ones kept forever.`,
      detail: 'The project and its file are not touched. Samples only these versions used are removed from storage a week later.',
      buttons: [
        { id: 'cancel', label: 'Keep them' },
        { id: 'delete', label: 'Delete all', danger: true },
      ],
      cancelId: 'cancel',
    });
    if (choice === 'delete') await services.versions.removeAllOf(projectId);
  };
  return (
    <div className={styles.footer}>
      <span>
        {isOtherProject ? 'That project' : 'This project'}: {plural(project.count, 'version')}, {formatSize(project.bytes)}. All projects: {plural(all.count, 'version')}, {formatSize(all.bytes)}.
        Kept: everything from the last day, one an hour for a week, one a day for a month; versions kept forever stay. Samples are stored once and shared.
      </span>
      <button className={`${styles.button} ${styles.danger}`} disabled={project.count === 0} onClick={() => void remove()} data-hint="Delete every version of this project, including the ones kept forever (the song itself stays)">
        Delete all…
      </button>
    </div>
  );
}

/**
 * Versions: save points of the song, newest first. Each says when it was made, why, and what changed since the one
 * before it. Listen to one without opening it, restore it (one undo step), open it as a copy, keep it forever or delete it.
 */
export function VersionsWindow() {
  const services = useServices();
  const view = useStore(services.versions.view);
  const openProjectId = useDoc((project) => project.projectId);
  const openTitle = services.files.store.getState().name;
  const now = useNow();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const isOtherProject = view.projectId !== null && view.projectId !== openProjectId;

  useEffect(() => {
    void services.versions.refresh();
  }, [services, openProjectId]);
  useEffect(() => () => services.versions.stopPreview(), [services]);

  const groups = useMemo(() => byDay(view.versions, now), [view.versions, now]);
  const toggle = (id: string) => setExpandedId((current) => (current === id ? null : id));
  const saveVersion = () => void services.commands.run('versions.save');

  return (
    <div className={styles.wrap}>
      <div className={styles.help}>
        A version is the whole song as it was at one moment. They are saved when you save, after minutes of editing and before big changes, so you can always go back. Listen to one, restore it (one undo step) or open it as a copy.
      </div>
      <div className={styles.bar}>
        <button
          className={`${styles.button} ${styles.primary}`}
          disabled={isOtherProject || !services.versions.isAvailable}
          onClick={saveVersion}
          data-hint="Keep the song as it is now as a named version (kept forever)"
        >
          Save a version…
        </button>
        <SavePointSettings services={services} />
      </div>
      {!services.versions.isAvailable && (
        <div className={styles.notice}>This browser has no private storage here (it needs https or localhost), so versions cannot be kept.</div>
      )}
      {isOtherProject && (
        <div className={styles.title}>
          <span>
            Versions of <b>{view.projectName || 'another project'}</b> (not open)
          </span>
          <button className={styles.small} onClick={() => void services.versions.showVersionsOf(null)} data-hint="Go back to the versions of the project you have open">
            Back to {openTitle}
          </button>
        </div>
      )}
      {view.versions.length === 0 ? (
        <div className={styles.empty}>
          {view.isLoading ? (
            'Looking for versions…'
          ) : (
            <>
              <b>No versions yet.</b>
              <p>The first one is made when you save, after a few minutes of editing, or before a big change. To make one now, press “Save a version…” and give it a name like “Before vocals”.</p>
            </>
          )}
        </div>
      ) : (
        <ul className={styles.list} aria-label="Versions, newest first">
          {groups.map((group) => (
            <li key={group.heading + group.versions[0]!.id} className={styles.group}>
              <div className={styles.day}>{group.heading}</div>
              <ul className={styles.groupList}>
                {group.versions.map((record) => (
                  <VersionRow
                    key={record.id}
                    record={record}
                    isOtherProject={isOtherProject}
                    isOpen={expandedId === record.id}
                    isPreviewing={view.previewingId === record.id}
                    isBusy={view.busyId === record.id}
                    now={now}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <Footer services={services} isOtherProject={isOtherProject} />
    </div>
  );
}
