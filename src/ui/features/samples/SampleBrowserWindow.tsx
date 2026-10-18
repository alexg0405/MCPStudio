import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { addRowAsClip, addRowsAsChannels, makeKitFromRows, previewRow, stopPreviewRow } from '@app/samples/actions';
import type { BrowserRow } from '@app/samples/browser';
import { addSampleFolder, canPickFolders, reconnectSampleFolder, sampleFolders } from '@app/persistence/sample-folders';
import { browse, countByCategory, fitsKey, keyLabel, SORT_LABELS, similarTo, type SampleSort } from '@core/samples/query';
import { CATEGORY_LABELS, SAMPLE_CATEGORIES } from '@core/samples/types';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useWindowedRows } from '../../controls/windowed';
import { startAudioFileDrag } from '../../audio-drag';
import { useDoc, useServices } from '../../services-context';
import styles from './Samples.module.css';
import {
  bpmText,
  EMPTY_NO_AUDIO_TEXT,
  EMPTY_NO_FOLDERS_TEXT,
  EMPTY_NO_FOLDERS_TITLE,
  EMPTY_NO_MATCH_TEXT,
  EMPTY_RECONNECT_TEXT,
  folderChoices,
  lengthText,
  progressText,
  ROW_H,
  rowHint,
  typeText,
} from './view';

const SORTS = Object.keys(SORT_LABELS) as SampleSort[];
const PITCHES = Array.from({ length: 12 }, (_, i) => i);

/** The sample browser: your sample folders, sorted out. Search and filter, click to hear, drag to use. */
export function SampleBrowserWindow() {
  const services = useServices();
  const browser = services.sampleBrowser;
  const rows = useStore(browser.store, (s) => s.rows);
  const filter = useStore(browser.store, (s) => s.filter);
  const sort = useStore(browser.store, (s) => s.sort);
  const descending = useStore(browser.store, (s) => s.descending);
  const selected = useStore(browser.store, (s) => s.selected);
  const cursor = useStore(browser.store, (s) => s.cursor);
  const playing = useStore(browser.store, (s) => s.playing);
  const progress = useStore(browser.store, (s) => s.progress);
  const volume = useStore(browser.store, (s) => s.volume);
  const syncTempo = useStore(browser.store, (s) => s.syncTempo);
  const syncMode = useStore(browser.store, (s) => s.syncMode);
  const inKey = useStore(browser.store, (s) => s.inKey);
  const autoPreview = useStore(browser.store, (s) => s.autoPreview);
  const folders = useStore(sampleFolders, (s) => s.folders);
  const songKey = useDoc((p) => p.transport.key);
  const [inSongKey, setInSongKey] = useState(false);
  const [similar, setSimilar] = useState<string | null>(null);
  const [bpmMin, setBpmMin] = useState('');
  const [bpmMax, setBpmMax] = useState('');
  const [tagText, setTagText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    browser.start();
  }, [browser]);

  const counts = useMemo(() => countByCategory(rows), [rows]);
  const choices = useMemo(() => folderChoices(rows), [rows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the tags come from the rows
  const allTags = useMemo(() => browser.allTags(), [browser, rows]);

  // What the list shows: the nearest sounds to one, or the filtered and sorted rows.
  const target = similar ? rows.find((r) => r.id === similar) : undefined;
  const visible = useMemo<BrowserRow[]>(() => {
    if (target) return similarTo(rows, target, 60).map((x) => x.row) as BrowserRow[];
    const list = browse(rows, filter, sort, descending) as BrowserRow[];
    return inSongKey ? list.filter((r) => fitsKey(r.analysis, songKey)) : list;
  }, [rows, filter, sort, descending, target, inSongKey, songKey]);

  const win = useWindowedRows(listRef, visible.length, ROW_H, { overscan: 10 });
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedRows = useMemo(() => visible.filter((r) => selectedSet.has(r.id)), [visible, selectedSet]);
  const cursorRow = cursor ? visible.find((r) => r.id === cursor) : undefined;
  const anyFilter =
    filter.text !== '' || filter.categories.length > 0 || filter.kind !== 'any' || filter.bpm !== null || filter.keys.length > 0 || filter.favorites || filter.recent || filter.tags.length > 0 || filter.under !== null || inSongKey;

  const toggleIn = <T,>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const setBpm = (lo: string, hi: string) => {
    setBpmMin(lo);
    setBpmMax(hi);
    const a = Number(lo);
    const b = Number(hi);
    if (lo === '' && hi === '') return browser.setFilter({ bpm: null });
    browser.setFilter({ bpm: [lo !== '' && a > 0 ? a : 0, hi !== '' && b > 0 ? b : 999] });
  };
  const clearAll = () => {
    browser.clearFilter();
    setBpmMin('');
    setBpmMax('');
    setInSongKey(false);
    setSimilar(null);
  };

  // ---- Rows ----

  const scrollTo = (index: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  const choose = (row: BrowserRow, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    // The selection as it is now (a render may not have happened since the last click).
    const { selected: current, cursor: at0 } = browser.store.getState();
    const index = visible.indexOf(row);
    if (e.shiftKey && at0) {
      const from = visible.findIndex((r) => r.id === at0);
      if (from >= 0) {
        const [a, b] = from < index ? [from, index] : [index, from];
        browser.setSelection(visible.slice(a, b + 1).map((r) => r.id), at0);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      browser.setSelection(toggleIn(current, row.id), row.id);
      return;
    }
    browser.setSelection([row.id], row.id);
    void previewRow(services, row, { toggle: true });
  };

  const move = (delta: number, extend: boolean) => {
    if (visible.length === 0) return;
    const now = browser.store.getState().cursor;
    const at = now ? visible.findIndex((r) => r.id === now) : -1;
    const next = Math.min(visible.length - 1, Math.max(0, at < 0 ? (delta > 0 ? 0 : visible.length - 1) : at + delta));
    const row = visible[next] as BrowserRow;
    scrollTo(next);
    if (extend && at >= 0) {
      const [a, b] = at < next ? [at, next] : [next, at];
      browser.setSelection(visible.slice(a, b + 1).map((r) => r.id), row.id);
    } else {
      browser.setSelection([row.id], row.id);
      if (autoPreview) void previewRow(services, row);
    }
  };

  const addToProject = (row: BrowserRow) => {
    if (row.analysis?.kind === 'loop') void addRowAsClip(services, row);
    else void addRowsAsChannels(services, [row]);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'ArrowDown':
        stop();
        move(1, e.shiftKey);
        break;
      case 'ArrowUp':
        stop();
        move(-1, e.shiftKey);
        break;
      case 'Home':
        stop();
        move(-visible.length, false);
        break;
      case 'End':
        stop();
        move(visible.length, false);
        break;
      case 'Enter':
        if (cursorRow) {
          stop();
          void previewRow(services, cursorRow, { toggle: true });
        }
        break;
      case 'a':
      case 'A':
        if (cursorRow && !e.metaKey && !e.ctrlKey && !e.altKey) {
          stop();
          addToProject(cursorRow);
        }
        break;
      case 'f':
      case 'F':
        if (cursorRow && !e.metaKey && !e.ctrlKey && !e.altKey) {
          stop();
          for (const r of selectedRows.length > 0 ? selectedRows : [cursorRow]) browser.toggleFavorite(r.id, !cursorRow.favorite);
        }
        break;
      case 'Escape':
        stop();
        stopPreviewRow(services);
        break;
    }
  };

  const rowMenu = (e: ReactMouseEvent, row: BrowserRow) => {
    e.preventDefault();
    const inSelection = selectedSet.has(row.id);
    const group = inSelection && selectedRows.length > 1 ? selectedRows : [row];
    if (!inSelection) browser.setSelection([row.id], row.id);
    const shots = group.filter((r) => r.analysis?.kind === 'one-shot');
    const items: MenuEntry[] = [
      { label: playing === row.id ? 'Stop' : 'Play', onSelect: () => void previewRow(services, row, { toggle: true }), hint: 'Hear this sound through the preview (loops play at the project tempo)' },
      { kind: 'separator' },
      { label: group.length > 1 ? `Add ${group.length} as sampler channels` : 'Add as a sampler channel', onSelect: () => void addRowsAsChannels(services, group), hint: 'One channel per sound on the channel rack, after the selected channel' },
      { label: 'Add to the playlist', onSelect: () => void addRowAsClip(services, row), hint: 'An audio clip at the song position marker, on the first track with room (a loop follows the song tempo)' },
      {
        label: shots.length > 1 ? `Make a drum kit from ${shots.length} one-shots` : 'Make a drum kit from the selected one-shots',
        disabled: shots.length < 1,
        onSelect: () => void makeKit(shots),
        hint: 'A Drum Pads channel: kick on pad 1, snare on 3, clap on 4, hats on 7 and 9, toms and cymbals on the others',
      },
      { kind: 'separator' },
      { label: 'Find similar sounds', onSelect: () => setSimilar(row.id), disabled: !row.analysis || row.analysis.kind === 'long', hint: 'The sounds that are closest to this one in brightness, length, pitch and tone' },
      { label: row.favorite ? 'Remove from favorites' : 'Add to favorites', onSelect: () => group.forEach((r) => browser.toggleFavorite(r.id, !row.favorite)) },
      { label: 'Add a tag…', onSelect: () => tagRef.current?.focus(), hint: 'Type your own word in the tag box below (Enter adds it to the selected sounds)' },
    ];
    for (const t of row.userTags) items.push({ label: `Remove tag “${t}”`, onSelect: () => group.forEach((r) => browser.removeTag(r.id, t)) });
    showContextMenu(e, items);
  };

  const makeKit = async (list: readonly BrowserRow[]) => {
    const res = await makeKitFromRows(services, list);
    const t = services.session.getState();
    if (!res.channelId) t.toast('No pad got a sound: pick one-shots that have been analyzed.', 'error');
    else t.toast(`Made a kit: ${res.placed.length} pad${res.placed.length === 1 ? '' : 's'}${res.plan.skipped.length ? `, ${res.plan.skipped.length} left out` : ''}`, 'info');
  };

  const addTag = () => {
    const targets = selectedRows.length > 0 ? selectedRows : cursorRow ? [cursorRow] : [];
    for (const r of targets) browser.addTag(r.id, tagText);
    setTagText('');
  };

  // ---- Empty states ----

  const noFolders = folders.length === 0;
  const needsAccess = folders.some((f) => f.access !== 'granted');
  const scanning = folders.some((f) => f.loading);
  let empty: { title: string; text: string; action?: { label: string; hint: string; run(): void } } | null = null;
  if (noFolders)
    empty = {
      title: EMPTY_NO_FOLDERS_TITLE,
      text: canPickFolders() ? EMPTY_NO_FOLDERS_TEXT : 'Sample folders need Chrome or Edge. You can still drag audio files from your computer onto the channel rack or the playlist.',
      ...(canPickFolders() ? { action: { label: 'Add folder…', hint: 'Pick a folder of your sounds (it stays on your computer; the browser keeps its place)', run: () => void addSampleFolder() } } : {}),
    };
  else if (rows.length === 0 && needsAccess)
    empty = { title: 'Allow access to your folders', text: EMPTY_RECONNECT_TEXT, action: { label: 'Reconnect…', hint: 'The browser asks again whether AGstudio may read your sample folders', run: () => folders.filter((f) => f.access !== 'granted').forEach((f) => void reconnectSampleFolder(f.key)) } };
  else if (rows.length === 0 && !scanning) empty = { title: 'No audio found', text: EMPTY_NO_AUDIO_TEXT };
  else if (rows.length === 0) empty = { title: 'Reading your folders…', text: 'Looking for audio files. This takes a moment for big folders.' };
  else if (visible.length === 0)
    empty = { title: similar ? 'Nothing similar yet' : 'No match', text: similar ? 'The other sounds are still being analyzed. Try again in a moment.' : EMPTY_NO_MATCH_TEXT, ...(anyFilter ? { action: { label: 'Clear filters', hint: 'Show every sound again', run: clearAll } } : {}) };

  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const status = progressText(progress);
  const columnSort = (s: SampleSort) => browser.setSort(s);

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <input
          className={styles.search}
          type="search"
          value={filter.text}
          placeholder="Search names and tags (kick, 128, a minor, -808)"
          aria-label="Search samples"
          data-hint="Type words to find sounds by name, folder, type, tempo, key or your tags; every word must match; put - before a word to leave it out"
          onChange={(e) => browser.setFilter({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (filter.text) browser.setFilter({ text: '' });
              else (e.target as HTMLElement).blur();
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              listRef.current?.focus();
              move(1, false);
            }
          }}
        />
        <select
          className={styles.select}
          aria-label="Folder"
          value={filter.under ?? ''}
          data-hint="Show only the sounds in one folder or subfolder"
          onChange={(e) => browser.setFilter({ under: e.target.value === '' ? null : e.target.value })}
        >
          <option value="">All folders ({rows.length.toLocaleString('en')})</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label} ({c.count.toLocaleString('en')})
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Sort by"
          value={sort}
          data-hint="Sort the list: by name, tempo, key, length, loudness, type or when you last used a sound"
          onChange={(e) => browser.setSort(e.target.value as SampleSort, false)}
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
        <button className={styles.button} onClick={() => browser.setSort(sort, !descending)} aria-label={descending ? 'Sorted high to low' : 'Sorted low to high'} data-hint={`Sorted ${descending ? 'high to low (Z to A, slow to fast)' : 'low to high (A to Z, slow to fast)'}: click to turn it round`}>
          {descending ? '↓' : '↑'}
        </button>
        {canPickFolders() && (
          <button className={styles.button} onClick={() => void addSampleFolder()} data-hint="Add another folder of samples from your computer (it stays in the browser)">
            <Icon name="plus" size={12} /> Add folder…
          </button>
        )}
      </div>

      <div className={styles.barQuiet}>
        <button className={filter.kind === 'any' && filter.categories.length === 0 ? styles.chipOn : styles.chip} onClick={() => browser.setFilter({ kind: 'any', categories: [] })} data-hint="Show every kind of sound">
          All<span className={styles.chipCount}>{counts.analyzed.toLocaleString('en')}</span>
        </button>
        {SAMPLE_CATEGORIES.filter((c) => counts.byCategory.has(c) || filter.categories.includes(c)).map((c) => (
          <button
            key={c}
            className={filter.categories.includes(c) ? styles.chipOn : styles.chip}
            onClick={() => browser.setFilter({ categories: toggleIn(filter.categories, c), kind: filter.kind === 'loop' ? 'any' : filter.kind })}
            data-hint={`${CATEGORY_LABELS[c]} one-shots: click to show only these (click more types to add them)`}
          >
            {CATEGORY_LABELS[c]}
            <span className={styles.chipCount}>{counts.byCategory.get(c) ?? 0}</span>
          </button>
        ))}
        <button
          className={filter.kind === 'loop' ? styles.chipOn : styles.chip}
          onClick={() => browser.setFilter({ kind: filter.kind === 'loop' ? 'any' : 'loop', categories: [] })}
          data-hint="Loops: rhythmic or musical phrases with a tempo and a number of bars"
        >
          Loops<span className={styles.chipCount}>{counts.loops}</span>
        </button>
        <span className={styles.spacer} />
        <button className={filter.favorites ? styles.chipOn : styles.chip} onClick={() => browser.setFilter({ favorites: !filter.favorites })} data-hint="Only the sounds you starred (press F on a sound, or click its star)">
          ★ Favorites
        </button>
        <button className={filter.recent ? styles.chipOn : styles.chip} onClick={() => browser.setFilter({ recent: !filter.recent })} data-hint="Only sounds you used in the project lately (sort by Recently used to see the newest first)">
          Recent
        </button>
        <button
          className={inSongKey ? styles.chipOn : styles.chip}
          disabled={!songKey}
          onClick={() => setInSongKey(!inSongKey)}
          data-hint={songKey ? 'Only sounds whose note or key fits the song key (set in the song settings)' : 'Set a key for the song first (song settings) to show only sounds that fit it'}
        >
          Song key
        </button>
      </div>

      <div className={styles.barQuiet}>
        <span className={styles.label}>Tempo</span>
        <input className={styles.number} inputMode="numeric" value={bpmMin} placeholder="from" aria-label="Lowest tempo in BPM" data-hint="Loops from this tempo (BPM) up" onChange={(e) => setBpm(e.target.value.replace(/[^\d]/g, ''), bpmMax)} />
        <input className={styles.number} inputMode="numeric" value={bpmMax} placeholder="to" aria-label="Highest tempo in BPM" data-hint="Loops up to this tempo (BPM)" onChange={(e) => setBpm(bpmMin, e.target.value.replace(/[^\d]/g, ''))} />
        <button
          className={filter.halfDouble ? styles.chipOn : styles.chip}
          onClick={() => browser.setFilter({ halfDouble: !filter.halfDouble })}
          data-hint="Also match loops at half or double the tempo (a 70 BPM loop fits a 140 BPM song)"
        >
          ½× 2×
        </button>
        {songKey && (
          <button className={styles.chip} onClick={() => setBpm(String(Math.round(services.doc.getState().project.transport.bpm - 4)), String(Math.round(services.doc.getState().project.transport.bpm + 4)))} data-hint="Set the tempo range to the song tempo, 4 BPM either way">
            Song tempo
          </button>
        )}
        <span className={styles.label} style={{ marginLeft: 8 }}>
          Key
        </span>
        {PITCHES.map((k) => (
          <button key={k} className={filter.keys.includes(k) ? styles.keyOn : styles.key} onClick={() => browser.setFilter({ keys: toggleIn(filter.keys, k) })} data-hint={`Sounds in ${keyLabel(k)}: a one-shot tuned to ${keyLabel(k)} or a loop in a ${keyLabel(k)} key`}>
            {keyLabel(k)}
          </button>
        ))}
        {allTags.length > 0 && (
          <>
            <span className={styles.label} style={{ marginLeft: 8 }}>
              Tags
            </span>
            {allTags.slice(0, 8).map((t) => (
              <button key={t.tag} className={filter.tags.includes(t.tag) ? styles.chipOn : styles.chip} onClick={() => browser.setFilter({ tags: toggleIn(filter.tags, t.tag) })} data-hint={`Your tag “${t.tag}”: show the ${t.count} sound${t.count === 1 ? '' : 's'} that have it`}>
                {t.tag}
                <span className={styles.chipCount}>{t.count}</span>
              </button>
            ))}
          </>
        )}
        {anyFilter && (
          <>
            <span className={styles.spacer} />
            <button className={styles.button} onClick={clearAll} data-hint="Remove every filter and the search words">
              Clear filters
            </button>
          </>
        )}
      </div>

      {progress.running && (
        <div className={styles.progress} role="progressbar" aria-label="Analysis progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} data-hint="The browser is working out what each sound is; you can use it meanwhile">
          <div className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
      )}

      {target && (
        <div className={styles.banner}>
          <span>
            Sounds like <strong>{target.name}</strong>
          </span>
          <span className={styles.spacer} />
          <button className={styles.button} onClick={() => setSimilar(null)} data-hint="Go back to the full list">
            Back to all sounds
          </button>
        </div>
      )}

      {empty ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>{empty.title}</div>
          <div className={styles.emptyText}>{empty.text}</div>
          {empty.action && (
            <button className={styles.primary} onClick={empty.action.run} data-hint={empty.action.hint}>
              {empty.action.label}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={styles.head}>
            <span />
            <button className={styles.headButton} tabIndex={-1} onClick={() => columnSort('name')} data-hint="Sort the list by name: click again to turn it round">
              Name
            </button>
            <button className={styles.headButton} tabIndex={-1} onClick={() => columnSort('category')} data-hint="Sort the list by type: click again to turn it round">
              Type
            </button>
            <button className={`${styles.headButton} ${styles.num}`} tabIndex={-1} onClick={() => columnSort('bpm')} data-hint="Sort the list by tempo: click again to turn it round">
              BPM
            </button>
            <button className={styles.headButton} tabIndex={-1} onClick={() => columnSort('key')} data-hint="Sort the list by key: click again to turn it round">
              Key
            </button>
            <button className={styles.headButton} tabIndex={-1} onClick={() => columnSort('length')} data-hint="Sort the list by length: click again to turn it round">
              Length
            </button>
            <span>Tags</span>
          </div>
          <div
            ref={listRef}
            className={styles.list}
            role="listbox"
            aria-label="Samples"
            aria-multiselectable
            tabIndex={0}
            onScroll={win.onScroll}
            onKeyDown={onKeyDown}
            data-hint="Click a sound to hear it; up and down arrows step through and play each one; Enter plays or stops; A adds it to the project; F stars it; Esc stops"
          >
            {win.padTop > 0 && <div aria-hidden style={{ height: win.padTop }} />}
            {visible.slice(win.first, win.last).map((row) => {
              const type = typeText(row);
              const key = row.analysis?.root !== undefined && row.analysis.keyConfidence !== undefined && row.analysis.keyConfidence >= 0.25 ? keyShort(row) : '';
              const isSel = selectedSet.has(row.id);
              return (
                <div
                  key={row.id}
                  role="option"
                  aria-selected={isSel}
                  className={`${styles.row} ${isSel ? styles.selected : ''} ${row.id === cursor ? styles.cursor : ''} ${row.id === playing ? styles.playing : ''}`}
                  draggable
                  data-sample-row={row.id}
                  data-hint={rowHint(row)}
                  onClick={(e) => choose(row, e)}
                  onDoubleClick={() => addToProject(row)}
                  onContextMenu={(e) => rowMenu(e, row)}
                  onDragStart={(e) => startAudioFileDrag(e.dataTransfer, row.handle)}
                >
                  <button
                    className={row.favorite ? styles.starOn : styles.star}
                    tabIndex={-1}
                    aria-pressed={row.favorite}
                    aria-label={row.favorite ? `Unstar ${row.name}` : `Star ${row.name}`}
                    data-hint={row.favorite ? 'A favorite: click to remove the star' : 'Click to star this sound as a favorite'}
                    onClick={(e) => {
                      e.stopPropagation();
                      browser.toggleFavorite(row.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    {row.favorite ? '★' : '☆'}
                  </button>
                  <span className={styles.name}>
                    {row.id === playing && <Icon name="play" size={9} />}
                    <span className={styles.nameText}>{row.name}</span>
                    {row.path.includes('/') && <span className={styles.dir}>{row.path.slice(0, row.path.lastIndexOf('/'))}</span>}
                  </span>
                  <span>
                    <span className={`${type.loop ? styles.typeLoop : styles.type} ${type.unsure ? styles.unsure : ''}`}>
                      {type.text}
                      {type.unsure && row.analysis?.category ? '?' : ''}
                    </span>
                  </span>
                  <span className={styles.num}>{bpmText(row.analysis)}</span>
                  <span>{key}</span>
                  <span className={styles.faint}>{row.analysis ? lengthText(row.analysis.durationSec) : ''}</span>
                  <span className={styles.tags}>
                    {row.userTags.slice(0, 3).map((t) => (
                      <span key={t} className={styles.tag}>
                        {t}
                      </span>
                    ))}
                    {row.userTags.length > 3 && <span className={styles.faint}>+{row.userTags.length - 3}</span>}
                  </span>
                </div>
              );
            })}
            {win.padBottom > 0 && <div aria-hidden style={{ height: win.padBottom }} />}
          </div>
        </>
      )}

      {selectedRows.length > 0 && (
        <div className={styles.selection}>
          <span className={styles.dim}>
            {selectedRows.length === 1 ? (cursorRow?.name ?? '1 selected') : `${selectedRows.length} selected`}
          </span>
          <input
            ref={tagRef}
            className={styles.tagInput}
            value={tagText}
            placeholder="Add a tag…"
            aria-label="Add a tag"
            data-hint="Type your own word (punchy, vinyl, verse…) and press Enter to tag the selected sounds; search and filter by it later"
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') addTag();
              if (e.key === 'Escape') {
                setTagText('');
                (e.target as HTMLElement).blur();
              }
            }}
          />
          {(cursorRow?.userTags ?? []).map((t) => (
            <button key={t} className={styles.tagChip} onClick={() => selectedRows.forEach((r) => browser.removeTag(r.id, t))} data-hint={`Remove the tag “${t}” from the selected sounds`}>
              {t}
              <Icon name="close" size={9} />
            </button>
          ))}
          <span className={styles.spacer} />
          {selectedRows.length > 1 && (
            <>
              <button className={styles.button} onClick={() => void addRowsAsChannels(services, selectedRows)} data-hint="Add each selected sound as its own sampler channel">
                Add {selectedRows.length} to the rack
              </button>
              <button
                className={styles.primary}
                disabled={!selectedRows.some((r) => r.analysis?.kind === 'one-shot')}
                onClick={() => void makeKit(selectedRows)}
                data-hint="A Drum Pads channel from the selected one-shots: kicks, snares, claps and hats go on the pads where a drum kit has them"
              >
                Make a kit from {selectedRows.filter((r) => r.analysis?.kind === 'one-shot').length} one-shots
              </button>
            </>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.label}>Preview</span>
        <input
          className={styles.volume}
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={volume}
          aria-label="Preview volume"
          data-hint={`Preview volume: ${Math.round(volume * 100)} % (only the preview, not your project)`}
          onChange={(e) => {
            const v = Number(e.target.value);
            browser.setPrefs({ volume: v });
            services.engine.setPreviewVolume(v);
          }}
        />
        <button className={syncTempo ? styles.toggleOn : styles.toggle} aria-pressed={syncTempo} onClick={() => browser.setPrefs({ syncTempo: !syncTempo })} data-hint="Loops play at the project tempo, starting on the next beat when the song is playing">
          Loops to song tempo
        </button>
        <span className={styles.seg} role="radiogroup" aria-label="How loops match the tempo">
          <button role="radio" aria-checked={syncMode === 'stretch'} className={syncMode === 'stretch' ? styles.segOn : styles.segItem} onClick={() => browser.setPrefs({ syncMode: 'stretch' })} data-hint="Stretch: change the speed and keep the pitch (best for most loops)">
            Stretch
          </button>
          <button role="radio" aria-checked={syncMode === 'resample'} className={syncMode === 'resample' ? styles.segOn : styles.segItem} onClick={() => browser.setPrefs({ syncMode: 'resample' })} data-hint="Resample: speed up or slow down like a record, the pitch follows (instant, and fine for drums)">
            Resample
          </button>
        </span>
        <button className={inKey ? styles.toggleOn : styles.toggle} aria-pressed={inKey} onClick={() => browser.setPrefs({ inKey: !inKey })} data-hint="Notes (tonal sounds, 808s, vocals) play moved onto the song key's note instead of their own; set the key in the song settings">
          Notes in song key
        </button>
        <button className={autoPreview ? styles.toggleOn : styles.toggle} aria-pressed={autoPreview} onClick={() => browser.setPrefs({ autoPreview: !autoPreview })} data-hint="Play each sound as you step through the list with the up and down arrow keys">
          Play on ↑ ↓
        </button>
        <span className={styles.spacer} />
        <button className={styles.button} onClick={() => stopPreviewRow(services)} disabled={!playing} data-hint="Stop the preview (Esc)">
          <Icon name="stop" size={10} /> Stop
        </button>
        {status && <span className={styles.status}>{status}</span>}
        {!status && rows.length > 0 && (
          <span className={styles.status}>
            {visible.length.toLocaleString('en')} of {rows.length.toLocaleString('en')} sounds
          </span>
        )}
      </div>
    </div>
  );
}

/** A row's key for the Key column ("A minor", "C♯"). */
function keyShort(row: BrowserRow): string {
  const a = row.analysis;
  if (!a || a.root === undefined) return '';
  return a.mode ? `${keyLabel(a.root)}${a.mode === 'minor' ? 'm' : ''}` : keyLabel(a.root);
}
