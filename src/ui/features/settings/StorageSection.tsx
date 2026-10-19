import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { storageService, type StorageStatus, type StorageUsage } from '@app/storage/service';
import { formatSize } from '@core/gc/format';
import { useServices } from '../../services-context';
import { Row, Section, Switch } from './parts';
import { cleanUpUnusedAudio } from './storage-flow';
import { amountText, automaticCleanupHint, lastRunText, otherText, unusedAudioHint } from './storage-text';
import styles from './Settings.module.css';

/** How often the numbers are measured again while the section is open and visible (ms). */
const REFRESH_EVERY_MS = 15_000;

/** A store that never changes, for the hooks below when there is no storage service. */
const EMPTY_STATUS = createStore<StorageStatus>(() => ({ supported: false, running: null, lastRun: null, dryRunOnly: false }));

/**
 * What the storage service measures: on opening, when asked (`refresh`), when a cleanup ends, and every so often while
 * this is open (other tabs and background work change the numbers).
 */
function useStorageUsage(service: ReturnType<typeof storageService>, isSupported: boolean, isIdle: boolean) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!service || !isSupported) return;
    let isCurrent = true;
    service.usage().then(
      (measured) => {
        if (!isCurrent) return;
        setFailed(false);
        setUsage(measured);
      },
      () => isCurrent && setFailed(true),
    );
    return () => {
      isCurrent = false;
    };
  }, [service, isSupported, isIdle, asked]);
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === 'visible' && setAsked((n) => n + 1), REFRESH_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);
  return { usage, failed, refresh: () => setAsked((n) => n + 1) };
}

/** Settings → Storage: what AGstudio keeps in this browser, and "Clean up unused audio". */
export function StorageSection() {
  const s = useServices();
  const service = storageService();
  const auto = useStore(s.prefs, (p) => p.autoCleanup);
  const running = useStore(service?.status ?? EMPTY_STATUS, (st) => st.running);
  const lastRun = useStore(service?.status ?? EMPTY_STATUS, (st) => st.lastRun);
  const dryRunOnly = useStore(service?.status ?? EMPTY_STATUS, (st) => st.dryRunOnly);
  const supported = !!service && service.status.getState().supported;
  const { usage, failed, refresh } = useStorageUsage(service, supported, running === null);

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
    <Section title="Storage" intro="What AGstudio keeps in this browser. Samples are stored once, even when several projects use them.">
      <Row label="Project audio" hint="Samples and recordings used by your open projects, their undo history and autosaves.">
        <span className={styles.value} data-testid="storage-project">
          {usage ? amountText(usage.projectAudio, 'file') : '…'}
        </span>
      </Row>
      <Row label="DJ library" hint="The songs in your DJ library.">
        <span className={styles.value} data-testid="storage-dj">
          {usage ? amountText(usage.djLibrary, 'song') : '…'}
        </span>
      </Row>
      <Row label="Stretched copies" hint="Time-stretched copies of long clips, kept so they don’t have to be made again. They are made again if removed.">
        <span className={styles.value} data-testid="storage-stretched">
          {usage ? amountText(usage.stretched, 'copy', 'copies') : '…'}
        </span>
      </Row>
      <Row label="Other" hint="Autosaves of your work in progress, and audio nothing uses any more (it stays for a week first).">
        <span className={styles.value} data-testid="storage-other">
          {usage ? otherText(usage.other) : '…'}
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
      <Row label="Unused audio" hint={removable && waiting ? unusedAudioHint(removable, waiting) : undefined}>
        <button
          className={styles.button}
          disabled={!!running}
          onClick={() => void cleanUpUnusedAudio(s).then(refresh)}
          data-hint="Show what would be removed (how many files and how much space), then ask before removing it"
        >
          {running ? `Cleaning up… ${running.total ? `${running.done} of ${running.total}` : ''}` : 'Clean up unused audio…'}
        </button>
      </Row>
      <Row label="Automatic" hint={automaticCleanupHint(dryRunOnly)}>
        <Switch checked={auto} onChange={() => s.commands.run('storage.autoCleanup')} label="Clean up unused audio by itself" />
      </Row>
      {lastRun && (
        <Row label="Last cleanup" hint="Any tab of this browser counts.">
          <span className={styles.value} data-testid="storage-last-run">
            {lastRunText(lastRun)}
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
