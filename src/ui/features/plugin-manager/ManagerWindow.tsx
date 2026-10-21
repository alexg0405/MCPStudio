import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { loadGallery, type GalleryItem } from '@app/plugins/gallery';
import type { PluginRow, TrashRow } from '@app/plugins/types';
import type { Services } from '@app/services';
import { useDoc, useServices } from '../../services-context';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { usageSentence } from './describe';
import { importBundleFile, installGalleryItem, sharePlugin } from './flows';
import { checkRow, deleteRow, disableRow, duplicateRow, enableRow, openFolderRow, renameRow, restoreRow, updateRow } from './row-actions';
import styles from './Manager.module.css';

const KIND_LABEL = { instrument: 'Instrument', effect: 'Effect', 'note-script': 'Piano-roll tool' } as const;

/** What the manager shows: the plugins, the trash, and whether the dev server is there. */
function useManagerData(services: Services) {
  const up = services.userPlugins;
  const state = useStore(up.store);
  const channels = useDoc((project) => project.channels);
  const mixer = useDoc((project) => project.mixer);
  const subscribe = useCallback(
    (notify: () => void) => {
      const stops = [services.plugins.subscribe(notify), up.meta.subscribe(notify)];
      return () => stops.forEach((stop) => stop());
    },
    [services, up],
  );
  const version = useSyncExternalStore(subscribe, () => services.plugins.getVersion());
  // The rows are worked out again whenever one of these changes: what is installed, what is on disk, or where the song uses it.
  const rows = useMemo(() => up.rows(), [up, version, state, channels, mixer]); // eslint-disable-line react-hooks/exhaustive-deps
  const trash = useMemo(() => up.trashRows(), [up, state]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, trash, server: state.server };
}

/** The plugin's one-line facts: kind, version, author. */
function facts(row: PluginRow): string {
  const parts = [row.kind ? KIND_LABEL[row.kind] : 'Plugin', row.version !== null ? `version ${row.version}` : null, row.author ? `by ${row.author}` : null];
  return parts.filter(Boolean).join(' · ');
}

/** The ⋯ menu of a plugin of yours: everything the buttons do not show. */
function rowMenu(services: Services, row: PluginRow): MenuEntry[] {
  const loaded = row.state === 'loaded';
  return [
    { label: 'Duplicate as a new plugin…', hint: 'Make a copy under a new name to change without touching this one', disabled: !loaded, onSelect: () => void duplicateRow(services, row) },
    { label: 'Change id…', hint: 'Give it another id; the song, your presets and chains follow (one undo step)', disabled: !loaded, onSelect: () => void renameRow(services, row) },
    { label: 'Update from a newer bundle…', hint: 'Replace its code with a newer .agplugin file; songs keep their settings', onSelect: () => void updateRow(services, row) },
    { label: 'Check the code', hint: 'Run the safety scan and the TypeScript check on it now', disabled: row.state === 'disabled', onSelect: () => void checkRow(services, row) },
    { kind: 'separator' },
    { label: 'Open its folder', hint: 'Show plugins/<folder> in your file manager', onSelect: () => void openFolderRow(services, row) },
    { kind: 'separator' },
    row.state === 'disabled'
      ? { label: 'Switch on', hint: 'Load it again', onSelect: () => void enableRow(services, row) }
      : { label: 'Switch off…', hint: 'Stop loading it without deleting anything', onSelect: () => void disableRow(services, row) },
    { label: 'Delete…', danger: true, hint: 'Move it to plugins/_trash (it can be brought back)', onSelect: () => void deleteRow(services, row) },
  ];
}

/** One plugin of yours. */
function UserRow({ row }: { row: PluginRow }) {
  const services = useServices();
  const used = usageSentence(row.usedIn);
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    showContextMenu(event, rowMenu(services, row));
  };
  return (
    <li className={`${styles.row} ${row.state !== 'loaded' ? styles.rowOff : ''}`} onContextMenu={openMenu} data-plugin-id={row.id}>
      <div className={styles.rowTop}>
        <div className={styles.rowName}>
          <b title={row.id}>{row.name}</b>
          {row.state === 'disabled' && <span className={styles.badge}>switched off</span>}
          {row.state === 'error' && <span className={`${styles.badge} ${styles.badgeError}`}>did not load</span>}
        </div>
        <div className={styles.rowButtons}>
          <button
            className={styles.small}
            disabled={row.state !== 'loaded'}
            onClick={() => void services.commands.run('plugins.editCode', row.id)}
            data-hint="Open this plugin’s code in your code editor: every save hot-reloads it and songs keep their settings"
          >
            Edit code
          </button>
          <button
            className={styles.small}
            disabled={row.state !== 'loaded'}
            onClick={() => void sharePlugin(services, row.id)}
            data-hint="Save this plugin as one .agplugin file to send to a friend"
          >
            Share…
          </button>
          <button className={styles.small} onClick={openMenu} aria-label={`More for ${row.name}`} data-hint="Duplicate, change id, update, check, open folder, switch off, delete">
            ⋯
          </button>
        </div>
      </div>
      <div className={styles.facts}>
        {facts(row)} · {row.id}
      </div>
      {row.description && row.state === 'loaded' && <div className={styles.desc}>{row.description}</div>}
      <div className={styles.use}>{used ? `Used in ${used}` : row.state === 'loaded' ? 'Not used in this song.' : ''}</div>
      {row.error && (
        <div className={styles.error} role="alert">
          {row.error}
        </div>
      )}
      {row.isChecked && (
        <div className={row.problems.length ? styles.error : styles.ok}>
          {row.problems.length ? `The last check found: ${row.problems.slice(0, 3).join(' · ')}${row.problems.length > 3 ? ` …and ${row.problems.length - 3} more` : ''}` : 'The last check found nothing.'}
        </div>
      )}
      {row.state === 'disabled' && (
        <button className={`${styles.small} ${styles.primary}`} onClick={() => void enableRow(services, row)} data-hint="Load this plugin again">
          Switch on
        </button>
      )}
    </li>
  );
}

function TrashList({ trash }: { trash: TrashRow[] }) {
  const services = useServices();
  if (trash.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Trash">
      <h3 className={styles.heading}>Trash</h3>
      <p className={styles.note}>Deleted plugins wait here (plugins/_trash). Restore one to use it again; delete the folder yourself to remove it for good.</p>
      <ul className={styles.list}>
        {trash.map((row) => (
          <li key={row.entry} className={styles.row}>
            <div className={styles.rowTop}>
              <div className={styles.rowName}>
                <b>{row.id ?? row.folder}</b>
              </div>
              <button className={styles.small} onClick={() => void restoreRow(services, row)} data-hint={`Move it back to plugins/${row.folder}`}>
                Restore
              </button>
            </div>
            <div className={styles.facts}>
              {row.fileCount} files · deleted {new Date(row.modified).toLocaleDateString()}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The example plugins: one click installs each (after the same dialog as any bundle). */
function Gallery({ rows, server }: { rows: PluginRow[]; server: string }) {
  const services = useServices();
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    let isCurrent = true;
    void loadGallery().then((loaded) => isCurrent && setItems(loaded));
    return () => {
      isCurrent = false;
    };
  }, []);
  const install = async (item: GalleryItem) => {
    setBusyId(item.id);
    try {
      await installGalleryItem(services, item);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <section className={styles.section} aria-label="Gallery">
      <h3 className={styles.heading}>Gallery</h3>
      <p className={styles.note}>Example plugins to try, and to read: each one is a few small files you can open with Edit code once it is installed.</p>
      {items === null ? (
        <p className={styles.note}>Loading…</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => {
            const installed = rows.find((row) => row.id === item.id);
            return (
              <li key={item.id} className={styles.row} data-gallery-id={item.id}>
                <div className={styles.rowTop}>
                  <div className={styles.rowName}>
                    <b>{item.name}</b>
                    <span className={styles.badge}>{KIND_LABEL[item.kind]}</span>
                  </div>
                  <button
                    className={`${styles.small} ${installed ? '' : styles.primary}`}
                    disabled={!!installed || busyId !== null || server === 'missing'}
                    onClick={() => void install(item)}
                    data-hint={installed ? 'Already installed: see it above' : server === 'missing' ? 'Installing needs the dev server (run agstudio)' : 'Show what it is and install it into your plugins folder'}
                  >
                    {installed ? 'Installed' : busyId === item.id ? 'Installing…' : 'Install'}
                  </button>
                </div>
                <div className={styles.desc}>{item.description}</div>
                <div className={styles.facts}>{item.style}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The built-in plugins, listed only so you can see everything in one place; they cannot be changed. */
function BuiltIns({ rows }: { rows: PluginRow[] }) {
  const builtin = rows.filter((row) => row.source === 'builtin');
  return (
    <details className={styles.section}>
      <summary className={styles.heading} data-hint="The plugins that come with AGstudio (read only)">
        Built in ({builtin.length})
      </summary>
      <ul className={styles.list}>
        {builtin.map((row) => (
          <li key={row.id} className={styles.rowCompact}>
            <b>{row.name}</b>
            <span className={styles.facts}>{facts(row)}</span>
            <span className={styles.badge}>read only</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * My plugins: your own instruments and effects as code, with everything you do to them in one place: edit, share as a
 * `.agplugin` file, import one, duplicate, change the id, switch off, delete (to a trash that can bring it back), and
 * the gallery of examples. Anything that touches the plugins/ folder needs the dev server (`agstudio`).
 */
export function ManagerWindow() {
  const services = useServices();
  const { rows, trash, server } = useManagerData(services);
  useEffect(() => {
    void services.userPlugins.refresh().catch(() => {});
  }, [services]);
  const mine = rows.filter((row) => row.source === 'user');
  return (
    <div className={styles.wrap}>
      <div className={styles.help}>
        Your own plugins live in the <b>plugins/</b> folder of this project as code. Share one as a single file, import one a friend sent
        (or drop the file on the window), and keep them tidy here.
      </div>
      <div className={styles.bar}>
        <button className={`${styles.button} ${styles.primary}`} onClick={() => void importBundleFile(services)} data-hint="Choose a .agplugin file; you see what it is and what it can do before it installs">
          Import a plugin…
        </button>
        <button className={styles.button} onClick={() => void services.commands.run('plugins.new')} data-hint="Start your own instrument, effect or piano-roll tool from a template">
          New plugin…
        </button>
        <button className={styles.button} onClick={() => void openFolderRow(services)} data-hint="Show the plugins folder in your file manager">
          Open plugins folder
        </button>
        <button className={styles.button} onClick={() => void services.userPlugins.refresh().catch(() => {})} data-hint="Read the plugins folder again">
          Refresh
        </button>
      </div>
      {server === 'missing' && (
        <div className={styles.notice} role="status">
          Installing, sharing and managing plugins needs AGstudio’s dev server: run <code>agstudio</code> (that is <code>npm run dev</code>) in a
          terminal and use the browser tab it opens. The installed app can’t do this.
        </div>
      )}
      <div className={styles.body}>
        <section className={styles.section} aria-label="Your plugins">
          <h3 className={styles.heading}>Your plugins ({mine.length})</h3>
          {mine.length === 0 ? (
            <p className={styles.empty}>
              You have no plugins of your own yet. Start one with <b>New plugin…</b>, import a bundle, or install an example from the gallery below.
            </p>
          ) : (
            <ul className={styles.list}>
              {mine.map((row) => (
                <UserRow key={`${row.id}:${row.folder}`} row={row} />
              ))}
            </ul>
          )}
        </section>
        <Gallery rows={mine} server={server} />
        <TrashList trash={trash} />
        <BuiltIns rows={rows} />
      </div>
    </div>
  );
}
