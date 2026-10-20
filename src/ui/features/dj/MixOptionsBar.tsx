import type { Dispatch, SetStateAction } from 'react';
import { stopMaking, type LibraryState } from '@app/dj/library';
import type { DjMixOptions } from '@core/model/types';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import styles from './Dj.module.css';
import { DEFAULT_FIXED_BPM, ENERGY_CHOICES, MAX_LENGTH_TARGET_MIN, MAX_MIX_BPM, MIN_MIX_BPM, ORDER_CHOICES, TRANSITION_CHOICES } from './dj-view';
import { makeMixFromUi } from './run';

/** A row of exclusive choices (a radio group drawn as buttons). */
function Segmented<T extends string>({
  value,
  choices,
  onChange,
  label,
}: {
  value: T;
  choices: readonly { value: T; label: string; hint: string }[];
  onChange(v: T): void;
  label: string;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.seg} role="radiogroup" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            role="radio"
            aria-checked={value === choice.value}
            className={value === choice.value ? styles.segOn : styles.segItem}
            onClick={() => onChange(choice.value)}
            data-hint={`${label}: ${choice.label}. ${choice.hint}`}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Follow the songs' tempos, or one fixed tempo for the whole mix. */
function MixTempoField({ options, set }: { options: DjMixOptions; set(patch: Partial<DjMixOptions>): void }) {
  const isFixed = options.mixTempo !== 'follow';
  return (
    <div className={styles.field}>
      <span className={styles.label}>Mix tempo</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div className={styles.seg} role="radiogroup" aria-label="Mix tempo">
          <button
            role="radio"
            aria-checked={!isFixed}
            className={isFixed ? styles.segItem : styles.segOn}
            onClick={() => set({ mixTempo: 'follow' })}
            data-hint="Each song plays at its own tempo; the tempo glides from one to the next during the transitions"
          >
            Follow songs
          </button>
          <button
            role="radio"
            aria-checked={isFixed}
            className={isFixed ? styles.segOn : styles.segItem}
            onClick={() => set({ mixTempo: options.mixTempo === 'follow' ? DEFAULT_FIXED_BPM : options.mixTempo })}
            data-hint="The whole mix plays at one tempo (every song is time-stretched to it)"
          >
            Fixed
          </button>
        </div>
        {options.mixTempo !== 'follow' && (
          <input
            className={styles.input}
            type="number"
            min={MIN_MIX_BPM}
            max={MAX_MIX_BPM}
            step={0.5}
            value={options.mixTempo}
            onChange={(e) => set({ mixTempo: Math.min(MAX_MIX_BPM, Math.max(MIN_MIX_BPM, Number(e.target.value) || DEFAULT_FIXED_BPM)) })}
            data-hint="The mix's tempo in BPM (50–250)"
          />
        )}
      </div>
    </div>
  );
}

/** Whether songs keep their pitch when the tempo glides (always on at a fixed tempo). */
function KeyLockField({ options, set }: { options: DjMixOptions; set(patch: Partial<DjMixOptions>): void }) {
  const isFixedTempo = options.mixTempo !== 'follow';
  const isOn = options.keyLock || isFixedTempo;
  const hint = isFixedTempo
    ? 'Key lock is always on at a fixed mix tempo'
    : options.keyLock
      ? 'Key lock on: songs keep their pitch when the tempo glides (time-stretched; beats can wobble a few ms). Click for turntable style'
      : 'Key lock off (turntable style): beats stay sample-exact and the pitch bends slightly with the tempo during transitions. Click to keep the pitch instead';
  return (
    <div className={styles.field}>
      <span className={styles.label}>Key lock</span>
      <div className={styles.seg}>
        <button aria-pressed={isOn} className={isOn ? styles.segOn : styles.segItem} disabled={isFixedTempo} onClick={() => set({ keyLock: !options.keyLock })} data-hint={hint}>
          {isOn ? 'On' : 'Off'}
        </button>
      </div>
    </div>
  );
}

/** How long the mix should be (minutes); empty plays every song through. */
function LengthField({ options, setOptions }: { options: DjMixOptions; setOptions: Dispatch<SetStateAction<DjMixOptions>> }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>Length</span>
      <input
        className={styles.input}
        type="number"
        min={0}
        max={MAX_LENGTH_TARGET_MIN}
        placeholder="all"
        value={options.lengthTargetMin ?? ''}
        onChange={(e) => {
          const minutes = Number(e.target.value);
          setOptions((current) => {
            const { lengthTargetMin: _dropped, ...rest } = current;
            void _dropped;
            return minutes > 0 ? { ...rest, lengthTargetMin: Math.min(MAX_LENGTH_TARGET_MIN, minutes) } : rest;
          });
        }}
        data-hint="Aim for about this many minutes (songs mix out earlier, by whole phrases). Empty: every song plays through"
      />
    </div>
  );
}

/** The mix options and the "Make the mix" button, with the progress bar of a mix being made. */
export function MixOptionsBar({
  library,
  options,
  setOptions,
  songsInMix,
}: {
  library: LibraryState;
  options: DjMixOptions;
  setOptions: Dispatch<SetStateAction<DjMixOptions>>;
  /** How many songs would go into the mix now. */
  songsInMix: number;
}) {
  const services = useServices();
  const set = (patch: Partial<DjMixOptions>) => setOptions((current) => ({ ...current, ...patch }));
  const isBusy = library.adding !== null || library.making !== null;
  const makeHint =
    songsInMix === 0
      ? 'Add songs first'
      : `Make a mix of ${songsInMix === library.songs.length ? 'every song' : `the ${songsInMix} selected songs`} on the playlist (one undo step; making it again replaces it)`;
  return (
    <>
      <div className={styles.options}>
        <Segmented label="Order" value={options.order} choices={ORDER_CHOICES} onChange={(order) => set({ order })} />
        <Segmented label="Energy" value={options.energy} choices={ENERGY_CHOICES} onChange={(energy) => set({ energy })} />
        <Segmented label="Transitions" value={options.transition} choices={TRANSITION_CHOICES} onChange={(transition) => set({ transition })} />
        <MixTempoField options={options} set={set} />
        <KeyLockField options={options} set={set} />
        <LengthField options={options} setOptions={setOptions} />
        <span className={styles.spacer} />
        {library.making ? (
          <button className={styles.button} onClick={stopMaking} data-hint="Stop making the mix">
            Stop
          </button>
        ) : null}
        <button className={styles.primary} disabled={isBusy || songsInMix === 0} onClick={() => void makeMixFromUi(services, options)} data-hint={makeHint}>
          <Icon name="sparkle" size={13} /> Make the mix
        </button>
      </div>
      {library.making && (
        <div className={styles.progress}>
          <span>{library.making.label}</span>
          <div className={styles.meter}>
            <div className={styles.meterFill} style={{ width: `${Math.round(library.making.fraction * 100)}%` }} />
          </div>
        </div>
      )}
    </>
  );
}
