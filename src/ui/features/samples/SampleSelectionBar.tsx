import type { RefObject } from 'react';
import type { BrowserRow, SampleBrowser } from '@app/samples/browser';
import { Icon } from '../../controls/Icon';
import styles from './Samples.module.css';

interface SampleSelectionBarProps {
  browser: SampleBrowser;
  selectedRows: readonly BrowserRow[];
  /** The sound the keyboard is on; its tags are the ones shown as removable chips. */
  cursorRow: BrowserRow | undefined;
  tagText: string;
  onTagTextChange(text: string): void;
  tagInputRef: RefObject<HTMLInputElement | null>;
  onAddTag(): void;
  onAddToRack(): void;
  onMakeKit(): void;
}

/** The strip under the list while sounds are selected: tag them, add them to the rack, or make a kit. */
export function SampleSelectionBar({ browser, selectedRows, cursorRow, tagText, onTagTextChange, tagInputRef, onAddTag, onAddToRack, onMakeKit }: SampleSelectionBarProps) {
  const oneShotCount = selectedRows.filter((r) => r.analysis?.kind === 'one-shot').length;
  return (
    <div className={styles.selection}>
      <span className={styles.dim}>{selectedRows.length === 1 ? (cursorRow?.name ?? '1 selected') : `${selectedRows.length} selected`}</span>
      <input
        ref={tagInputRef}
        className={styles.tagInput}
        value={tagText}
        placeholder="Add a tag…"
        aria-label="Add a tag"
        data-hint="Type your own word (punchy, vinyl, verse…) and press Enter to tag the selected sounds; search and filter by it later"
        onChange={(e) => onTagTextChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') onAddTag();
          if (e.key === 'Escape') {
            onTagTextChange('');
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
          <button className={styles.button} onClick={onAddToRack} data-hint="Add each selected sound as its own sampler channel">
            Add {selectedRows.length} to the rack
          </button>
          <button
            className={styles.primary}
            disabled={oneShotCount === 0}
            onClick={onMakeKit}
            data-hint="A Drum Pads channel from the selected one-shots: kicks, snares, claps and hats go on the pads where a drum kit has them"
          >
            Make a kit from {oneShotCount} one-shots
          </button>
        </>
      )}
    </div>
  );
}
