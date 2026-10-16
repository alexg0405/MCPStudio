import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { storageService, type StorageStatus, type StorageUsage } from '@app/storage/service';
import { formatSize, plural } from '@core/gc/format';
import { useServices } from '../../services-context';
import { Row, Section, Switch } from './parts';
import { cleanUpUnusedAudio } from './storage-flow';
import styles from './Settings.module.css';

/** A store that never changes, for the hooks below when there is no storage service. */
const EMPTY_STATUS = createStore<StorageStatus>(() => ({ supported: false, running: null, lastRun: null, dryRunOnly: false }));

/** Plain words for one row of the table: "12.5 MB in 3 files". */
const amount = (b: { files: number; bytes: number }, one: string, many?: string) =>
  b.files === 0 ? 'Nothing' : `${formatSize(b.bytes)} in ${plural(b.files, one, many)}`;

/** Settings → Storage: what AGstudio keeps in this browser, and "Clean up unused audio". */
export function StorageSection() {
  const s = useServices();
  const svc = storageService();
  const auto = useStore(s.prefs, (p) => p.autoCleanup);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const running = useStore(svc?.status ?? EMPTY_STATUS, (st) => st.running);
  const lastRun = useStore(svc?.status ?? EMPTY_STATUS, (st) => st.lastRun);
  const dryRunOnly = useStore(svc?.status ?? EMPTY_STATUS, (st) => st.dryRunOnly);
  const supported = !!svc && svc.status.getState().supported;

  // Measured on opening, when asked, and again when a cleanup ends.
  const [asked, setAsked] = useState(0);
  const idle = running === null;
  useEffect(() => {
    if (!svc || !supported) return;
    let current = true;
    svc.usage().then(
      (u) => {
        if (!current) return;
        setFailed(false);
        setUsage(u);
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [svc, supported, idle, asked]);
  // Other tabs and background work change the numbers: look again now and then while this is open.
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === 'visible' && setAsked((n) => n + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const refresh = () => setAsked((n) => n + 1);

  if (!supported) {
    return (
      <Section title="Storage" intro="What AGstudio keeps in this browser: your samples, songs and autosaves.">
        <Row label="Unavailable" hint="This browser doesn’t give AGstudio private storage here (it needs https or localhost), so nothing is saved or cleaned up.">
          <span className={styles.value}>—</span>
        </Row>
      </Section>
    );
  }

  const removable = usage?.unused.removable;
  const waiting = usage?.unused.waiting;
  return (
    <Section
      title="Storage"
      intro="What AGstudio keeps in this browser. Samples are stored once, even when several projects use them."
    >
      <Row label="Project audio" hint="Samples and recordings used by your open projects, their undo history and autosaves.">
        <span className={styles.value} data-testid="storage-project">{usage ? amount(usage.projectAudio, 'file') : '…'}</span>
      </Row>
      <Row label="DJ library" hint="The songs in your DJ library.">
        <span className={styles.value} data-testid="storage-dj">{usage ? amount(usage.djLibrary, 'song') : '…'}</span>
      </Row>
      <Row label="Stretched copies" hint="Time-stretched copies of long clips, kept so they don’t have to be made again. They are made again if removed.">
        <span className={styles.value} data-testid="storage-stretched">{usage ? amount(usage.stretched, 'copy', 'copies') : '…'}</span>
      </Row>
      <Row
        label="Other"
        hint="Autosaves of your work in progress, and audio nothing uses any more (it stays for a week first)."
      >
        <span className={styles.value} data-testid="storage-other">
          {usage
            ? usage.other.bytes === 0
              ? 'Nothing'
              : `${formatSize(usage.other.bytes)} (${formatSize(usage.other.autosaveBytes)} autosaves, ${formatSize(usage.other.unusedBytes)} unused audio)`
            : '…'}
        </span>
      </Row>
      <Row label="Total" hint="All of the above added together.">
        <span className={styles.value} data-testid="storage-total">
          <strong>{usage ? formatSize(usage.total) : '…'}</strong>
        </span>
        <button className={styles.button} onClick={refresh} data-hint="Measure again">
          Refresh
        </button>
      </Row>
      <Row
        label="Unused audio"
        hint={
          removable && waiting
            ? removable.files > 0
              ? `${plural(removable.files, 'file')} (${formatSize(removable.bytes)}) can go now: nothing uses ${removable.files === 1 ? 'it' : 'them'} and ${removable.files === 1 ? 'it has' : 'they have'} sat unused for over a week.${waiting.files > 0 ? ` ${plural(waiting.files, 'more file')} (${formatSize(waiting.bytes)}) waits out its first week.` : ''}`
              : waiting.files > 0
                ? `${plural(waiting.files, 'file')} (${formatSize(waiting.bytes)}) isn’t used by anything, but stays for a week in case you need ${waiting.files === 1 ? 'it' : 'them'} back.`
                : 'All the audio stored here is in use.'
            : undefined
        }
      >
        <button
          className={styles.button}
          disabled={!!running}
          onClick={() => void cleanUpUnusedAudio(s).then(refresh)}
          data-hint="Show what would be removed (how many files and how much space), then ask before removing it"
        >
          {running ? `Cleaning up… ${running.total ? `${running.done} of ${running.total}` : ''}` : 'Clean up unused audio…'}
        </button>
      </Row>
      <Row
        label="Automatic"
        hint={
          'When AGstudio is idle (never while playing or exporting), audio that nothing uses is removed a week after it was last used. ' +
          'Projects you saved to a file keep their own copy of their audio, so they open fine either way.' +
          (dryRunOnly ? ' This development build only writes to the console what it would remove.' : '')
        }
      >
        <Switch
          checked={auto}
          onChange={() => s.commands.run('storage.autoCleanup')}
          label="Clean up unused audio by itself"
        />
      </Row>
      {lastRun && (
        <Row label="Last cleanup" hint="Any tab of this browser counts.">
          <span className={styles.value} data-testid="storage-last-run">
            {new Date(lastRun.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}:{' '}
            {lastRun.dryRun
              ? `would have removed ${plural(lastRun.removed, 'file')} (${formatSize(lastRun.bytes)})`
              : `removed ${plural(lastRun.removed, 'file')} (${formatSize(lastRun.bytes)})`}
          </span>
        </Row>
      )}
      {failed && (
        <Row label="" hint="Couldn’t measure the storage just now. Try Refresh.">
          <span />
        </Row>
      )}
    </Section>
  );
}
