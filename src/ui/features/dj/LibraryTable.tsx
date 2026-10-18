import { useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { TrackAnalyzer } from '@app/dj/analysis-cache';
import { moveSong, removeSongs, setSelection, togglePin, type LibrarySong, type LibraryState } from '@app/dj/library';
import type { TrackAnalysis } from '@core/dj/types';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useWindowedRows } from '../../controls/windowed';
import { useServices } from '../../services-context';
import { loadToDeckMenu, SONG_DRAG_TYPE } from '../dj-decks/load';
import styles from './Dj.module.css';
import { bpmText, formatLength, keyBadge, sparkPoints, statusText } from './dj-view';

/** A library row's height in px: the CSS of `.table td` (30) fixes it; the windowed list relies on it. */
const ROW_HEIGHT_PX = 30;

/** The width and height of a row's energy sparkline (px). */
const SPARK_WIDTH_PX = 64;
const SPARK_HEIGHT_PX = 16;

/** Columns of the table (the padding rows span all of them). */
const COLUMN_COUNT = 9;

/** The music list of the DJ window: select, reorder by dragging, pin, remove. Only the rows near the viewport are drawn. */
export function LibraryTable({ library: state, analyzer }: { library: LibraryState; analyzer: TrackAnalyzer | null }) {
  const services = useServices();
  const tableRef = useRef<HTMLDivElement>(null);
  const windowedRows = useWindowedRows(tableRef, state.songs.length, ROW_HEIGHT_PX);
  /** Index of the row a dragged song would land before, while dragging. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const selected = new Set(state.selected);
  const analysisOf = (song: LibrarySong): TrackAnalysis | null => analyzer?.peek(song.key) ?? null;

  /** Click selects; Shift-click selects the range from the last selected song. */
  const toggleSelected = (key: string, e: { shiftKey: boolean }) => {
    if (!e.shiftKey || state.selected.length === 0) {
      setSelection(selected.has(key) ? state.selected.filter((k) => k !== key) : [...state.selected, key]);
      return;
    }
    const keys = state.songs.map((song) => song.key);
    const anchor = keys.indexOf(state.selected[state.selected.length - 1]!);
    const clicked = keys.indexOf(key);
    setSelection([...state.selected, ...keys.slice(Math.min(anchor, clicked), Math.max(anchor, clicked) + 1)]);
  };

  const dropBefore = (e: DragEvent, index: number) => {
    e.preventDefault();
    const key = e.dataTransfer.getData(SONG_DRAG_TYPE);
    setDropIndex(null);
    if (!key) return;
    const from = state.songs.findIndex((song) => song.key === key);
    void moveSong(key, from < index ? index - 1 : index);
  };

  const openRowMenu = (e: ReactMouseEvent, song: LibrarySong) => {
    e.preventDefault();
    const keys = selected.has(song.key) ? state.selected : [song.key];
    showContextMenu(e, [
      ...loadToDeckMenu(services, song),
      { kind: 'separator' },
      { label: song.pinned ? 'Unpin' : 'Pin to this place', onSelect: () => void togglePin(song.key) },
      { label: 'Move to the top', onSelect: () => void moveSong(song.key, 0) },
      { label: 'Move to the end', onSelect: () => void moveSong(song.key, state.songs.length) },
      { kind: 'separator' },
      { label: keys.length > 1 ? `Remove ${keys.length} songs from the library` : 'Remove from the library', danger: true, onSelect: () => void removeSongs(keys) },
    ]);
  };

  return (
    <div className={styles.tableWrap} ref={tableRef} onScroll={windowedRows.onScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={state.songs.length > 0 && state.selected.length === state.songs.length}
                onChange={(e) => setSelection(e.target.checked ? state.songs.map((song) => song.key) : [])}
                data-hint="Select every song (or none: then every song goes in the mix anyway)"
              />
            </th>
            <th className={styles.num}>#</th>
            <th>Song</th>
            <th className={styles.right} data-hint="Length (minutes:seconds)">
              Length
            </th>
            <th className={styles.right} data-hint="Tempo in beats per minute">
              BPM
            </th>
            <th data-hint="Key on the Camelot wheel: neighbours (±1, or A↔B) mix smoothly">Key</th>
            <th data-hint="Energy along the song (loud, busy parts are high)">Energy</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {windowedRows.padTop > 0 && <PaddingRow height={windowedRows.padTop} />}
          {state.songs.slice(windowedRows.first, windowedRows.last).map((song, k) => {
            const index = windowedRows.first + k;
            return (
              <SongRow
                key={song.key}
                song={song}
                index={index}
                analysis={analysisOf(song)}
                status={state.analysis[song.key]}
                analyzerMissing={state.analyzerMissing}
                isSelected={selected.has(song.key)}
                isDropTarget={dropIndex === index}
                onToggle={(e) => toggleSelected(song.key, e)}
                onMenu={(e) => openRowMenu(e, song)}
                onDragOverRow={() => setDropIndex(index)}
                onDragLeaveRow={() => setDropIndex(null)}
                onDropRow={(e) => dropBefore(e, index)}
              />
            );
          })}
          {windowedRows.padBottom > 0 && <PaddingRow height={windowedRows.padBottom} />}
        </tbody>
      </table>
    </div>
  );
}

/** An empty row that stands in for the rows scrolled out of view. */
function PaddingRow({ height }: { height: number }) {
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={COLUMN_COUNT} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

/** One song of the list. */
function SongRow({
  song,
  index,
  analysis,
  status,
  analyzerMissing,
  isSelected,
  isDropTarget,
  onToggle,
  onMenu,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
}: {
  song: LibrarySong;
  index: number;
  analysis: TrackAnalysis | null;
  status: LibraryState['analysis'][string] | undefined;
  analyzerMissing: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  onToggle(e: ReactMouseEvent): void;
  onMenu(e: ReactMouseEvent): void;
  onDragOverRow(): void;
  onDragLeaveRow(): void;
  onDropRow(e: DragEvent): void;
}) {
  const badge = keyBadge(analysis);
  return (
    <tr
      className={`${styles.row} ${isSelected ? styles.selected : ''} ${isDropTarget ? styles.dropBefore : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SONG_DRAG_TYPE, song.key);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SONG_DRAG_TYPE)) return;
        e.preventDefault();
        onDragOverRow();
      }}
      onDragLeave={onDragLeaveRow}
      onDrop={onDropRow}
      onClick={onToggle}
      onContextMenu={onMenu}
      data-hint={`${song.label}: click to select (Shift for a range), drag to reorder (or onto a deck in the DJ decks window), right-click for more`}
    >
      <td>
        <input type="checkbox" aria-label={`Select ${song.label}`} checked={isSelected} onChange={() => {}} tabIndex={-1} />
      </td>
      <td className={styles.num}>{index + 1}</td>
      <td className={styles.title} title={song.fileName}>
        {song.title}
        {song.artist && <span className={styles.artist}>{song.artist}</span>}
      </td>
      <td className={styles.right}>{formatLength(song.durationSec)}</td>
      <td className={styles.right} data-hint={analysis?.grid ? `${bpmText(analysis)} BPM (${Math.round(analysis.grid.confidence * 100)} % sure of the beat grid)` : 'Tempo: not known yet'}>
        {bpmText(analysis)}
      </td>
      <td>
        <span
          className={styles.badge}
          style={badge.color ? { background: `color-mix(in srgb, ${badge.color} 70%, var(--ag-surface-1))`, color: 'var(--ag-on-light)' } : undefined}
          data-hint={badge.hint}
        >
          {badge.text}
        </span>
      </td>
      <td>
        {analysis ? (
          <svg className={styles.spark} width={SPARK_WIDTH_PX} height={SPARK_HEIGHT_PX} aria-hidden data-hint="Energy along the song">
            <polyline points={sparkPoints(analysis.energy, SPARK_WIDTH_PX, SPARK_HEIGHT_PX)} fill="none" stroke="currentColor" strokeWidth={1.2} />
          </svg>
        ) : (
          <span className={styles.status}>{statusText(analysis, status, analyzerMissing)}</span>
        )}
      </td>
      <td>
        <button
          className={song.pinned ? styles.pinOn : styles.pin}
          onClick={(e) => {
            e.stopPropagation();
            void togglePin(song.key);
          }}
          data-hint={song.pinned ? 'Pinned: auto order keeps this song at this place. Click to unpin' : 'Pin: auto order keeps this song at this place in the list'}
        >
          {song.pinned ? 'Pinned' : 'Pin'}
        </button>
      </td>
      <td>
        <button
          className={styles.pin}
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            void removeSongs([song.key]);
          }}
          data-hint="Remove from the library (the file on your computer stays)"
        >
          <Icon name="close" size={10} />
        </button>
      </td>
    </tr>
  );
}
