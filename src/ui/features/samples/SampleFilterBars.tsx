import type { SampleBrowser } from '@app/samples/browser';
import type { SongKey } from '@core/model/types';
import { keyLabel, type SampleFilter } from '@core/samples/query';
import { CATEGORY_LABELS, SAMPLE_CATEGORIES } from '@core/samples/types';
import styles from './Samples.module.css';
import { toggleIn } from './filters';

const PITCH_CLASSES = Array.from({ length: 12 }, (_, i) => i);
/** How many of your tags get a button (the most used first); the search box finds the rest. */
const MAX_TAG_BUTTONS = 8;

/** How many sounds there are of each kind, for the numbers on the chips. */
interface KindCounts {
  analyzed: number;
  loops: number;
  byCategory: ReadonlyMap<string, number>;
}

interface KindChipsProps {
  browser: SampleBrowser;
  filter: SampleFilter;
  counts: KindCounts;
  isInSongKey: boolean;
  /** The song's key, or undefined when none is set (the Song key chip needs one). */
  songKey: SongKey | undefined;
  onToggleSongKey(): void;
}

/** The second bar: sound-type chips (All, kinds of one-shot, Loops) and the Favorites, Recent and Song key chips. */
export function KindChips({ browser, filter, counts, isInSongKey, songKey, onToggleSongKey }: KindChipsProps) {
  const isAllSelected = filter.kind === 'any' && filter.categories.length === 0;
  return (
    <div className={styles.barQuiet}>
      <button className={isAllSelected ? styles.chipOn : styles.chip} onClick={() => browser.setFilter({ kind: 'any', categories: [] })} data-hint="Show every kind of sound">
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
        className={isInSongKey ? styles.chipOn : styles.chip}
        disabled={!songKey}
        onClick={onToggleSongKey}
        data-hint={songKey ? 'Only sounds whose note or key fits the song key (set in the song settings)' : 'Set a key for the song first (song settings) to show only sounds that fit it'}
      >
        Song key
      </button>
    </div>
  );
}

interface TempoKeyTagBarProps {
  browser: SampleBrowser;
  filter: SampleFilter;
  /** What is typed in the two tempo boxes. */
  bpmMinText: string;
  bpmMaxText: string;
  onBpmTextChange(lowText: string, highText: string): void;
  /** Fills the tempo boxes from the song tempo (shown only when the song has a key set, as before). */
  onUseSongTempo(): void;
  songKey: SongKey | undefined;
  /** Your tags with how many sounds carry each, most used first. */
  tags: readonly { tag: string; count: number }[];
  hasActiveFilter: boolean;
  onClearAll(): void;
}

/** The third bar: tempo range, pitch buttons, your tags and Clear filters. */
export function TempoKeyTagBar(props: TempoKeyTagBarProps) {
  const { browser, filter, bpmMinText, bpmMaxText, onBpmTextChange } = props;
  const digitsOnly = (text: string) => text.replace(/[^\d]/g, '');
  return (
    <div className={styles.barQuiet}>
      <span className={styles.label}>Tempo</span>
      <input
        className={styles.number}
        inputMode="numeric"
        value={bpmMinText}
        placeholder="from"
        aria-label="Lowest tempo in BPM"
        data-hint="Loops from this tempo (BPM) up"
        onChange={(e) => onBpmTextChange(digitsOnly(e.target.value), bpmMaxText)}
      />
      <input
        className={styles.number}
        inputMode="numeric"
        value={bpmMaxText}
        placeholder="to"
        aria-label="Highest tempo in BPM"
        data-hint="Loops up to this tempo (BPM)"
        onChange={(e) => onBpmTextChange(bpmMinText, digitsOnly(e.target.value))}
      />
      <button
        className={filter.halfDouble ? styles.chipOn : styles.chip}
        onClick={() => browser.setFilter({ halfDouble: !filter.halfDouble })}
        data-hint="Also match loops at half or double the tempo (a 70 BPM loop fits a 140 BPM song)"
      >
        ½× 2×
      </button>
      {props.songKey && (
        <button className={styles.chip} onClick={props.onUseSongTempo} data-hint="Set the tempo range to the song tempo, 4 BPM either way">
          Song tempo
        </button>
      )}
      <span className={styles.label} style={{ marginLeft: 8 }}>
        Key
      </span>
      {PITCH_CLASSES.map((pitchClass) => (
        <button
          key={pitchClass}
          className={filter.keys.includes(pitchClass) ? styles.keyOn : styles.key}
          onClick={() => browser.setFilter({ keys: toggleIn(filter.keys, pitchClass) })}
          data-hint={`Sounds in ${keyLabel(pitchClass)}: a one-shot tuned to ${keyLabel(pitchClass)} or a loop in a ${keyLabel(pitchClass)} key`}
        >
          {keyLabel(pitchClass)}
        </button>
      ))}
      {props.tags.length > 0 && <TagButtons browser={browser} filter={filter} tags={props.tags} />}
      {props.hasActiveFilter && (
        <>
          <span className={styles.spacer} />
          <button className={styles.button} onClick={props.onClearAll} data-hint="Remove every filter and the search words">
            Clear filters
          </button>
        </>
      )}
    </div>
  );
}

/** One button per tag you made (the most used few): click to show only the sounds that have it. */
function TagButtons({ browser, filter, tags }: { browser: SampleBrowser; filter: SampleFilter; tags: readonly { tag: string; count: number }[] }) {
  return (
    <>
      <span className={styles.label} style={{ marginLeft: 8 }}>
        Tags
      </span>
      {tags.slice(0, MAX_TAG_BUTTONS).map((t) => (
        <button
          key={t.tag}
          className={filter.tags.includes(t.tag) ? styles.chipOn : styles.chip}
          onClick={() => browser.setFilter({ tags: toggleIn(filter.tags, t.tag) })}
          data-hint={`Your tag “${t.tag}”: show the ${t.count} sound${t.count === 1 ? '' : 's'} that have it`}
        >
          {t.tag}
          <span className={styles.chipCount}>{t.count}</span>
        </button>
      ))}
    </>
  );
}
