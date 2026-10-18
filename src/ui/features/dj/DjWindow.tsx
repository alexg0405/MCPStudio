import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { trackAnalyzer } from '@app/dj/analyzer';
import { analyzeLibrary, library, loadLibrary, pickSongFiles, pickSongFolder, songsToMix, type LibraryState } from '@app/dj/library';
import { DEFAULT_DJ_OPTIONS, planOfCurrentMix } from '@app/dj/mix';
import type { DjMixOptions } from '@core/model/types';
import { canPickFolders } from '@app/persistence/sample-folders';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import styles from './Dj.module.css';
import { EMPTY_TEXT, libraryLine } from './dj-view';
import { LibraryTable } from './LibraryTable';
import { MixOptionsBar } from './MixOptionsBar';
import { TransitionsList } from './TransitionsList';

/** Re-renders when an analysis lands. */
function useAnalysisVersion(): number {
  const services = useServices();
  const [version, setVersion] = useState(0);
  useEffect(() => trackAnalyzer(services)?.subscribe(() => setVersion((v) => v + 1)), [services]);
  return version;
}

/** The DJ window: your music, the mix options, "Make the mix", and the transitions of the mix. */
export function DjWindow() {
  const services = useServices();
  const state = useStore(library);
  const analysisVersion = useAnalysisVersion();
  const mix = useDoc((p) => p.dj);
  const [options, setOptions] = useState<DjMixOptions>(() => services.doc.getState().project.dj?.options ?? DEFAULT_DJ_OPTIONS);
  useEffect(() => {
    void loadLibrary().then(() => analyzeLibrary(services));
  }, [services]);

  const analyzer = trackAnalyzer(services);
  const songsInMix = songsToMix(state);
  const totalSec = songsInMix.reduce((sum, song) => sum + (song.durationSec ?? 0), 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the analyses change under `analysisVersion`
  const plan = useMemo(() => (mix ? planOfCurrentMix(services, services.doc.getState().project) : null), [mix, services, analysisVersion]);

  return (
    <div className={styles.dj} data-tour="dj">
      <LibraryBar library={state} songCount={songsInMix.length} totalSec={totalSec} />
      {state.loaded && state.songs.length === 0 ? <EmptyLibrary /> : <LibraryTable library={state} analyzer={analyzer} />}
      <MixOptionsBar library={state} options={options} setOptions={setOptions} songsInMix={songsInMix.length} />
      {mix && <TransitionsList mix={mix} plan={plan} analyzer={analyzer} />}
    </div>
  );
}

/** The bar above the list: add files or a folder, what is being added, and how many songs go in the mix. */
function LibraryBar({ library: state, songCount, totalSec }: { library: LibraryState; songCount: number; totalSec: number }) {
  const services = useServices();
  const isBusy = state.adding !== null || state.making !== null;
  return (
    <div className={styles.bar}>
      <span className={styles.label}>Music</span>
      <button
        className={styles.button}
        onClick={() => void pickSongFiles(services)}
        disabled={isBusy}
        data-hint="Add song files from your computer (MP3, AAC/M4A, WAV, FLAC, OGG). They stay in this browser"
      >
        <Icon name="plus" size={12} /> Add files…
      </button>
      {canPickFolders() && (
        <button className={styles.button} onClick={() => void pickSongFolder(services)} disabled={isBusy} data-hint="Add every song in a folder (and its subfolders), up to 500">
          <Icon name="folder" size={13} /> Add folder…
        </button>
      )}
      <span className={styles.spacer} />
      {state.adding && (
        <span className={styles.dim}>
          Adding {state.adding.done + 1} of {state.adding.total}: {state.adding.name}
        </span>
      )}
      {state.songs.length > 0 && (
        <span className={styles.dim} data-hint={state.selected.length ? 'The selected songs go in the mix' : 'Select songs to mix only those; with none selected, every song goes in'}>
          {state.selected.length ? `${state.selected.length} selected · ` : ''}
          {libraryLine(songCount, totalSec)}
        </span>
      )}
    </div>
  );
}

/** What an empty library says: what the window is for and how to start. */
function EmptyLibrary() {
  const services = useServices();
  return (
    <div className={styles.empty}>
      <Icon name="note" size={28} />
      <div className={styles.emptyTitle}>Make a party mix from your own songs</div>
      <div className={styles.emptyText}>{EMPTY_TEXT}</div>
      <div className={styles.emptyText}>Then press “Make the mix”: Studio orders the songs, matches their beats and builds every transition on the playlist.</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={styles.primary} onClick={() => void pickSongFiles(services)} data-hint="Add song files from your computer">
          Add music files…
        </button>
        {canPickFolders() && (
          <button className={styles.button} onClick={() => void pickSongFolder(services)} data-hint="Add every song in a folder">
            Add a folder…
          </button>
        )}
      </div>
    </div>
  );
}
