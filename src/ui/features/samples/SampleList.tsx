import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { BrowserRow, SampleBrowser } from '@app/samples/browser';
import { keyLabel, type SampleSort } from '@core/samples/query';
import { Icon } from '../../controls/Icon';
import type { Windowed } from '../../controls/windowed';
import { startAudioFileDrag } from '../../audio-drag';
import styles from './Samples.module.css';
import { bpmText, lengthText, rowHint, typeText } from './view';

/** A key is shown in the Key column only when the analysis is at least this sure of it (0 to 1). */
const MIN_KEY_CONFIDENCE_TO_SHOW = 0.25;
/** How many of a sound's tags fit in its row before "+n". */
const MAX_TAGS_IN_ROW = 3;

/** The sortable columns: the sort they pick and the word the hint uses for them. */
const COLUMNS: readonly { sort: SampleSort; label: string; hintWord: string; isNumeric?: boolean }[] = [
  { sort: 'name', label: 'Name', hintWord: 'name' },
  { sort: 'category', label: 'Type', hintWord: 'type' },
  { sort: 'bpm', label: 'BPM', hintWord: 'tempo', isNumeric: true },
  { sort: 'key', label: 'Key', hintWord: 'key' },
  { sort: 'length', label: 'Length', hintWord: 'length' },
];

/** The column titles above the list; each sorts by its column. */
function ColumnHeads({ browser }: { browser: SampleBrowser }) {
  return (
    <div className={styles.head}>
      <span />
      {COLUMNS.map((column) => (
        <button
          key={column.sort}
          className={column.isNumeric ? `${styles.headButton} ${styles.num}` : styles.headButton}
          onClick={() => browser.setSort(column.sort)}
          data-hint={`Sort the list by ${column.hintWord}: click again to turn it round`}
        >
          {column.label}
        </button>
      ))}
      <span>Tags</span>
    </div>
  );
}

/** A row's key for the Key column ("A minor", "C♯"). */
function keyShort(row: BrowserRow): string {
  const a = row.analysis;
  if (!a || a.root === undefined) return '';
  return a.mode ? `${keyLabel(a.root)}${a.mode === 'minor' ? 'm' : ''}` : keyLabel(a.root);
}

/** The key to show for a row: empty unless the analysis found one with enough confidence. */
function shownKey(row: BrowserRow): string {
  const a = row.analysis;
  const isSure = a?.root !== undefined && a.keyConfidence !== undefined && a.keyConfidence >= MIN_KEY_CONFIDENCE_TO_SHOW;
  return isSure ? keyShort(row) : '';
}

interface SampleRowViewProps {
  browser: SampleBrowser;
  row: BrowserRow;
  isSelected: boolean;
  isCursor: boolean;
  isPlaying: boolean;
  onChoose(row: BrowserRow, modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void;
  onAddToProject(row: BrowserRow): void;
  onMenu(e: ReactMouseEvent, row: BrowserRow): void;
}

/** One sound in the list: star, name and folder, type, tempo, key, length and tags. Drag it onto the rack, the playlist or a pad. */
function SampleRowView({ browser, row, isSelected, isCursor, isPlaying, onChoose, onAddToProject, onMenu }: SampleRowViewProps) {
  const type = typeText(row);
  const className = `${styles.row} ${isSelected ? styles.selected : ''} ${isCursor ? styles.cursor : ''} ${isPlaying ? styles.playing : ''}`;
  return (
    <div
      role="option"
      aria-selected={isSelected}
      className={className}
      draggable
      data-sample-row={row.id}
      data-hint={rowHint(row)}
      onClick={(e) => onChoose(row, e)}
      onDoubleClick={() => onAddToProject(row)}
      onContextMenu={(e) => onMenu(e, row)}
      onDragStart={(e) => startAudioFileDrag(e.dataTransfer, row.handle)}
    >
      <button
        className={row.favorite ? styles.starOn : styles.star}
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
        {isPlaying && <Icon name="play" size={9} />}
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
      <span>{shownKey(row)}</span>
      <span className={styles.faint}>{row.analysis ? lengthText(row.analysis.durationSec) : ''}</span>
      <span className={styles.tags}>
        {row.userTags.slice(0, MAX_TAGS_IN_ROW).map((t) => (
          <span key={t} className={styles.tag}>
            {t}
          </span>
        ))}
        {row.userTags.length > MAX_TAGS_IN_ROW && <span className={styles.faint}>+{row.userTags.length - MAX_TAGS_IN_ROW}</span>}
      </span>
    </div>
  );
}

interface SampleListProps {
  browser: SampleBrowser;
  /** The rows the list shows, in order. */
  rows: readonly BrowserRow[];
  /** Which of them are in the window (the list draws only these; see `useWindowedRows`). */
  window: Windowed;
  listRef: RefObject<HTMLDivElement | null>;
  selectedIds: ReadonlySet<string>;
  cursorId: string | null;
  playingId: string | null;
  onKeyDown(e: ReactKeyboardEvent): void;
  onChoose: SampleRowViewProps['onChoose'];
  onAddToProject: SampleRowViewProps['onAddToProject'];
  onMenu: SampleRowViewProps['onMenu'];
}

/** The column titles and the windowed list of sounds below them. */
export function SampleList({ browser, rows, window: win, listRef, selectedIds, cursorId, playingId, onKeyDown, onChoose, onAddToProject, onMenu }: SampleListProps) {
  return (
    <>
      <ColumnHeads browser={browser} />
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
        {rows.slice(win.first, win.last).map((row) => (
          <SampleRowView
            key={row.id}
            browser={browser}
            row={row}
            isSelected={selectedIds.has(row.id)}
            isCursor={row.id === cursorId}
            isPlaying={row.id === playingId}
            onChoose={onChoose}
            onAddToProject={onAddToProject}
            onMenu={onMenu}
          />
        ))}
        {win.padBottom > 0 && <div aria-hidden style={{ height: win.padBottom }} />}
      </div>
    </>
  );
}
