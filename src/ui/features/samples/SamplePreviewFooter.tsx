import type { Services } from '@app/services';
import type { BrowserState, SampleBrowser } from '@app/samples/browser';
import { stopPreviewRow } from '@app/samples/actions';
import { Icon } from '../../controls/Icon';
import styles from './Samples.module.css';

interface SamplePreviewFooterProps {
  services: Services;
  browser: SampleBrowser;
  /** The preview settings as the model holds them now. */
  prefs: Pick<BrowserState, 'volume' | 'syncTempo' | 'syncMode' | 'inKey' | 'autoPreview'>;
  /** The id of the sound being auditioned, if any. */
  playingId: string | null;
  /** The analysis progress line ("Analyzing 340 of 5,000 files"), or empty when idle. */
  statusText: string;
  visibleCount: number;
  rowCount: number;
}

/** Highest preview level: a linear gain of 1.5 leaves some room above the project's own level. */
const MAX_PREVIEW_VOLUME = 1.5;

/** The bottom bar: preview volume, how loops and notes are auditioned, Stop, and the count or analysis status. */
export function SamplePreviewFooter({ services, browser, prefs, playingId, statusText, visibleCount, rowCount }: SamplePreviewFooterProps) {
  const { volume, syncTempo, syncMode, inKey, autoPreview } = prefs;
  return (
    <div className={styles.footer}>
      <span className={styles.label}>Preview</span>
      <input
        className={styles.volume}
        type="range"
        min={0}
        max={MAX_PREVIEW_VOLUME}
        step={0.01}
        value={volume}
        aria-label="Preview volume"
        data-hint={`Preview volume: ${Math.round(volume * 100)} % (only the preview, not your project)`}
        onChange={(e) => {
          const newVolume = Number(e.target.value);
          browser.setPrefs({ volume: newVolume });
          services.engine.setPreviewVolume(newVolume);
        }}
      />
      <button className={syncTempo ? styles.toggleOn : styles.toggle} aria-pressed={syncTempo} onClick={() => browser.setPrefs({ syncTempo: !syncTempo })} data-hint="Loops play at the project tempo, starting on the next beat when the song is playing">
        Loops to song tempo
      </button>
      <span className={styles.seg} role="radiogroup" aria-label="How loops match the tempo">
        <button
          role="radio"
          aria-checked={syncMode === 'stretch'}
          className={syncMode === 'stretch' ? styles.segOn : styles.segItem}
          onClick={() => browser.setPrefs({ syncMode: 'stretch' })}
          data-hint="Stretch: change the speed and keep the pitch (best for most loops)"
        >
          Stretch
        </button>
        <button
          role="radio"
          aria-checked={syncMode === 'resample'}
          className={syncMode === 'resample' ? styles.segOn : styles.segItem}
          onClick={() => browser.setPrefs({ syncMode: 'resample' })}
          data-hint="Resample: speed up or slow down like a record, the pitch follows (instant, and fine for drums)"
        >
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
      <button className={styles.button} onClick={() => stopPreviewRow(services)} disabled={!playingId} data-hint="Stop the preview (Esc)">
        <Icon name="stop" size={10} /> Stop
      </button>
      {statusText && <span className={styles.status}>{statusText}</span>}
      {!statusText && rowCount > 0 && (
        <span className={styles.status}>
          {visibleCount.toLocaleString('en')} of {rowCount.toLocaleString('en')} sounds
        </span>
      )}
    </div>
  );
}
