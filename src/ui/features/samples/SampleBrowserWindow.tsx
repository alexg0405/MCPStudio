import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { addRowsAsChannels } from '@app/samples/actions';
import type { BrowserRow, SampleBrowser } from '@app/samples/browser';
import { sampleFolders } from '@app/persistence/sample-folders';
import { browse, countByCategory, fitsKey, similarTo } from '@core/samples/query';
import { showContextMenu } from '../../controls/ContextMenu';
import { useWindowedRows } from '../../controls/windowed';
import { useDoc, useServices } from '../../services-context';
import styles from './Samples.module.css';
import { pickEmptyState, type EmptyState } from './empty-state';
import { bpmFilterFor, hasActiveFilter } from './filters';
import { makeKitWithToast, rowMenuEntries } from './row-actions';
import { KindChips, TempoKeyTagBar } from './SampleFilterBars';
import { SampleList } from './SampleList';
import { SamplePreviewFooter } from './SamplePreviewFooter';
import { SampleSearchBar } from './SampleSearchBar';
import { SampleSelectionBar } from './SampleSelectionBar';
import { useSampleNavigation } from './useSampleNavigation';
import { folderChoices, progressText, ROW_H } from './view';

/** How many sounds "Find similar" lists. */
const SIMILAR_SOUND_COUNT = 60;
/** Rows drawn beyond the visible ones, so a fast scroll does not show blanks. */
const LIST_OVERSCAN_ROWS = 10;
/** The "Song tempo" button sets the tempo range this many BPM either side of the song tempo. */
const SONG_TEMPO_RANGE_BPM = 4;

/** The sample browser: your sample folders, sorted out. Search and filter, click to hear, drag to use. */
export function SampleBrowserWindow() {
  const services = useServices();
  const browser = services.sampleBrowser;
  const state = useBrowserState(browser);
  const { rows, filter, selected, cursor, playing } = state;
  const folders = useStore(sampleFolders, (s) => s.folders);
  const songKey = useDoc((p) => p.transport.key);

  // View-only choices that are not part of the browser model: they reset with the window.
  const [isInSongKey, setIsInSongKey] = useState(false);
  const [similarToId, setSimilarToId] = useState<string | null>(null);
  const [bpmMinText, setBpmMinText] = useState('');
  const [bpmMaxText, setBpmMaxText] = useState('');
  const [tagText, setTagText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    browser.start();
  }, [browser]);

  const counts = useMemo(() => countByCategory(rows), [rows]);
  const choices = useMemo(() => folderChoices(rows), [rows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the tags come from the rows
  const allTags = useMemo(() => browser.allTags(), [browser, rows]);

  // What the list shows: the nearest sounds to one, or the filtered and sorted rows.
  const similarTarget = similarToId ? rows.find((r) => r.id === similarToId) : undefined;
  const visible = useMemo<BrowserRow[]>(() => {
    if (similarTarget) return similarTo(rows, similarTarget, SIMILAR_SOUND_COUNT).map((x) => x.row) as BrowserRow[];
    const list = browse(rows, filter, state.sort, state.descending) as BrowserRow[];
    return isInSongKey ? list.filter((r) => fitsKey(r.analysis, songKey)) : list;
  }, [rows, filter, state.sort, state.descending, similarTarget, isInSongKey, songKey]);

  const windowedRows = useWindowedRows(listRef, visible.length, ROW_H, { overscan: LIST_OVERSCAN_ROWS });
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const selectedRows = useMemo(() => visible.filter((r) => selectedIds.has(r.id)), [visible, selectedIds]);
  const cursorRow = cursor ? visible.find((r) => r.id === cursor) : undefined;
  const anyFilter = hasActiveFilter(filter, isInSongKey);

  const navigation = useSampleNavigation({ services, browser, visible, listRef, autoPreview: state.autoPreview, cursorRow, selectedRows });

  const setBpmRange = (lowText: string, highText: string) => {
    setBpmMinText(lowText);
    setBpmMaxText(highText);
    browser.setFilter({ bpm: bpmFilterFor(lowText, highText) });
  };
  const fillSongTempoRange = () => {
    const songBpm = services.doc.getState().project.transport.bpm;
    setBpmRange(String(Math.round(songBpm - SONG_TEMPO_RANGE_BPM)), String(Math.round(songBpm + SONG_TEMPO_RANGE_BPM)));
  };
  const clearAllFilters = () => {
    browser.clearFilter();
    setBpmMinText('');
    setBpmMaxText('');
    setIsInSongKey(false);
    setSimilarToId(null);
  };

  const showRowMenu = (e: ReactMouseEvent, row: BrowserRow) => {
    e.preventDefault();
    const isInSelection = selectedIds.has(row.id);
    const group = isInSelection && selectedRows.length > 1 ? selectedRows : [row];
    if (!isInSelection) browser.setSelection([row.id], row.id);
    const entries = rowMenuEntries({
      services,
      browser,
      row,
      group,
      playingId: playing,
      onFindSimilar: () => setSimilarToId(row.id),
      onFocusTagBox: () => tagInputRef.current?.focus(),
    });
    showContextMenu(e, entries);
  };

  const addTagToSelection = () => {
    const cursorOnly = cursorRow ? [cursorRow] : [];
    const targets = selectedRows.length > 0 ? selectedRows : cursorOnly;
    for (const r of targets) browser.addTag(r.id, tagText);
    setTagText('');
  };

  const empty = pickEmptyState({
    folders,
    rowCount: rows.length,
    visibleCount: visible.length,
    isShowingSimilar: Boolean(similarToId),
    hasActiveFilter: anyFilter,
    clearAllFilters,
  });

  return (
    <div className={styles.root}>
      <SampleSearchBar
        browser={browser}
        filter={filter}
        sort={state.sort}
        descending={state.descending}
        rowCount={rows.length}
        folderChoices={choices}
        listRef={listRef}
        onStepIntoList={() => navigation.move(1, false)}
      />
      <KindChips browser={browser} filter={filter} counts={counts} isInSongKey={isInSongKey} songKey={songKey} onToggleSongKey={() => setIsInSongKey(!isInSongKey)} />
      <TempoKeyTagBar
        browser={browser}
        filter={filter}
        bpmMinText={bpmMinText}
        bpmMaxText={bpmMaxText}
        onBpmTextChange={setBpmRange}
        onUseSongTempo={fillSongTempoRange}
        songKey={songKey}
        tags={allTags}
        hasActiveFilter={anyFilter}
        onClearAll={clearAllFilters}
      />

      {state.progress.running && <AnalysisProgressBar done={state.progress.done} total={state.progress.total} />}
      {similarTarget && <SimilarBanner targetName={similarTarget.name} onBack={() => setSimilarToId(null)} />}

      {empty ? (
        <EmptyMessage empty={empty} />
      ) : (
        <SampleList
          browser={browser}
          rows={visible}
          window={windowedRows}
          listRef={listRef}
          selectedIds={selectedIds}
          cursorId={cursor}
          playingId={playing}
          onKeyDown={navigation.onKeyDown}
          onChoose={navigation.choose}
          onAddToProject={navigation.addToProject}
          onMenu={showRowMenu}
        />
      )}

      {selectedRows.length > 0 && (
        <SampleSelectionBar
          browser={browser}
          selectedRows={selectedRows}
          cursorRow={cursorRow}
          tagText={tagText}
          onTagTextChange={setTagText}
          tagInputRef={tagInputRef}
          onAddTag={addTagToSelection}
          onAddToRack={() => void addRowsAsChannels(services, selectedRows)}
          onMakeKit={() => void makeKitWithToast(services, selectedRows)}
        />
      )}

      <SamplePreviewFooter
        services={services}
        browser={browser}
        prefs={state}
        playingId={playing}
        statusText={progressText(state.progress)}
        visibleCount={visible.length}
        rowCount={rows.length}
      />
    </div>
  );
}

/** The parts of the browser model the window follows (one subscription each, so only a real change re-renders). */
function useBrowserState(browser: SampleBrowser) {
  const store = browser.store;
  return {
    rows: useStore(store, (s) => s.rows),
    filter: useStore(store, (s) => s.filter),
    sort: useStore(store, (s) => s.sort),
    descending: useStore(store, (s) => s.descending),
    selected: useStore(store, (s) => s.selected),
    cursor: useStore(store, (s) => s.cursor),
    playing: useStore(store, (s) => s.playing),
    progress: useStore(store, (s) => s.progress),
    volume: useStore(store, (s) => s.volume),
    syncTempo: useStore(store, (s) => s.syncTempo),
    syncMode: useStore(store, (s) => s.syncMode),
    inKey: useStore(store, (s) => s.inKey),
    autoPreview: useStore(store, (s) => s.autoPreview),
  };
}

/** The thin bar under the filters while the browser is working out what each sound is. */
function AnalysisProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className={styles.progress} role="progressbar" aria-label="Analysis progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} data-hint="The browser is working out what each sound is; you can use it meanwhile">
      <div className={styles.progressFill} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** The strip above the list while it shows the sounds closest to one sound. */
function SimilarBanner({ targetName, onBack }: { targetName: string; onBack(): void }) {
  return (
    <div className={styles.banner}>
      <span>
        Sounds like <strong>{targetName}</strong>
      </span>
      <span className={styles.spacer} />
      <button className={styles.button} onClick={onBack} data-hint="Go back to the full list">
        Back to all sounds
      </button>
    </div>
  );
}

/** The message that takes the list's place when there is nothing to list, with its next step. */
function EmptyMessage({ empty }: { empty: EmptyState }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{empty.title}</div>
      <div className={styles.emptyText}>{empty.text}</div>
      {empty.action && (
        <button className={styles.primary} onClick={empty.action.run} data-hint={empty.action.hint}>
          {empty.action.label}
        </button>
      )}
    </div>
  );
}
