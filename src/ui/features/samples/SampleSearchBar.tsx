import type { RefObject } from 'react';
import { addSampleFolder, canPickFolders } from '@app/persistence/sample-folders';
import type { SampleBrowser } from '@app/samples/browser';
import { SORT_LABELS, type SampleFilter, type SampleSort } from '@core/samples/query';
import { Icon } from '../../controls/Icon';
import styles from './Samples.module.css';
import type { FolderChoice } from './view';

const SORTS = Object.keys(SORT_LABELS) as SampleSort[];

interface SampleSearchBarProps {
  browser: SampleBrowser;
  filter: SampleFilter;
  sort: SampleSort;
  descending: boolean;
  /** How many sounds the folders hold (the "All folders" count). */
  rowCount: number;
  folderChoices: readonly FolderChoice[];
  listRef: RefObject<HTMLDivElement | null>;
  /** Down arrow in the search box: the list takes the keyboard and steps to its first sound. */
  onStepIntoList(): void;
}

/** The top bar: the search box, the folder and sort pickers and the add-folder button. */
export function SampleSearchBar({ browser, filter, sort, descending, rowCount, folderChoices, listRef, onStepIntoList }: SampleSearchBarProps) {
  return (
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
            onStepIntoList();
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
        <option value="">All folders ({rowCount.toLocaleString('en')})</option>
        {folderChoices.map((c) => (
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
      <button
        className={styles.button}
        onClick={() => browser.setSort(sort, !descending)}
        aria-label={descending ? 'Sorted high to low' : 'Sorted low to high'}
        data-hint={`Sorted ${descending ? 'high to low (Z to A, slow to fast)' : 'low to high (A to Z, slow to fast)'}: click to turn it round`}
      >
        {descending ? '↓' : '↑'}
      </button>
      {canPickFolders() && (
        <button className={styles.button} onClick={() => void addSampleFolder()} data-hint="Add another folder of samples from your computer (it stays in the browser)">
          <Icon name="plus" size={12} /> Add folder…
        </button>
      )}
    </div>
  );
}
