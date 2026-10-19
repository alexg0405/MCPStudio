import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { KEYS_VELOCITIES, type KeysVelocity } from '@app/stores/prefs';
import { keyName } from '@core/time/ppq';
import { useServices } from '../../services-context';
import { keyVelocity, padKey, padVelocity, pianoLayout, PAD_COLUMNS, PAD_ROWS } from './key-math';
import { useTouchNotes, type PressPlace } from './use-touch-notes';
import styles from './KeysPanel.module.css';

type Page = 'piano' | 'pads';

/** How many octaves the piano shows (plus the last C), and the lowest and highest first octave the buttons allow. */
const OCTAVES = 3;
const FIRST_OCTAVE = 0;
const LAST_FIRST_OCTAVE = 7;
const DEFAULT_OCTAVE = 4;

const VELOCITY_LABELS: Record<KeysVelocity, string> = {
  position: 'By touch position',
  soft: 'Soft',
  medium: 'Medium',
  loud: 'Loud',
};

/** Where a press landed on its key or pad, as shares of its box (0 = left / top, 1 = right / bottom). */
function shareOf(place: PressPlace): { across: number; down: number } {
  const box = place.element.getBoundingClientRect();
  return { across: (place.clientX - box.left) / Math.max(1, box.width), down: (place.clientY - box.top) / Math.max(1, box.height) };
}

/** The piano: white and black keys, played by any number of fingers, sliding across keys plays each one. */
function Piano({ octave, velocity }: { octave: number; velocity: KeysVelocity }) {
  const first = octave * 12;
  const keys = useMemo(() => pianoLayout(first, first + OCTAVES * 12), [first]);
  const notes = useTouchNotes({ velocityAt: (place) => keyVelocity(velocity, shareOf(place).down), slides: true });
  return (
    <div className={styles.piano} data-touch-own="" data-hint="Keys: touch with several fingers to play chords. Lower on a key plays louder (unless a velocity is chosen above)" {...notes.handlers}>
      {keys.map((k) => (
        <div
          key={k.key}
          data-key={k.key}
          className={`${k.isBlack ? styles.black : styles.white} ${notes.lit.has(k.key) ? styles.on : ''}`}
          style={{ left: `${k.left * 100}%`, width: `${k.width * 100}%` }}
          data-hint={keyName(k.key)}
        >
          {k.key % 12 === 0 && <span className={styles.cLabel}>{keyName(k.key)}</span>}
        </div>
      ))}
    </div>
  );
}

/** The drum pads: sixteen, pad 1 at the bottom left, each playing the key the Drum Pads instrument listens to. */
function Pads({ velocity }: { velocity: KeysVelocity }) {
  const notes = useTouchNotes({
    velocityAt: (place) => {
      const { across, down } = shareOf(place);
      return padVelocity(velocity, across, down);
    },
    slides: false,
  });
  const cells = Array.from({ length: PAD_COLUMNS * PAD_ROWS }, (_, i) => padKey(i % PAD_COLUMNS, Math.floor(i / PAD_COLUMNS)));
  return (
    <div className={styles.pads} data-touch-own="" data-hint="Pads: tap to play, hit the middle of a pad for the loudest hit" {...notes.handlers}>
      {cells.map((key) => (
        <div key={key} data-key={key} className={`${styles.pad} ${notes.lit.has(key) ? styles.padOn : ''}`} data-hint={`Pad ${key - 35}: ${keyName(key)}`}>
          <span className={styles.padNumber}>{key - 35}</span>
          <span className={styles.padNote}>{keyName(key)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The on-screen keys: a piano and sixteen drum pads that play the selected channel. Made for fingers: every finger
 * plays its own note, so chords and rolls work, and the velocity comes from where a finger lands (or one fixed level).
 */
export function KeysPanel() {
  const services = useServices();
  const velocity = useStore(services.prefs, (p) => p.keysVelocity);
  const [page, setPage] = useState<Page>('piano');
  const [octave, setOctave] = useState(DEFAULT_OCTAVE);
  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <span className={styles.tabs} role="tablist" aria-label="Keys">
          {(['piano', 'pads'] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={page === p}
              className={`${styles.tab} ${page === p ? styles.tabOn : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setPage(p)}
              data-hint={p === 'piano' ? 'Play the selected channel on a piano' : 'Play drums on sixteen pads (the Drum Pads instrument listens to these keys)'}
            >
              {p === 'piano' ? 'Piano' : 'Pads'}
            </button>
          ))}
        </span>
        {page === 'piano' && (
          <span className={styles.octaves}>
            <button
              className={styles.step}
              disabled={octave <= FIRST_OCTAVE}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setOctave((o) => Math.max(FIRST_OCTAVE, o - 1))}
              aria-label="Octave down"
              data-hint="Octave down"
            >
              −
            </button>
            <span className={styles.octaveLabel}>{keyName(octave * 12)}</span>
            <button
              className={styles.step}
              disabled={octave >= LAST_FIRST_OCTAVE}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setOctave((o) => Math.min(LAST_FIRST_OCTAVE, o + 1))}
              aria-label="Octave up"
              data-hint="Octave up"
            >
              +
            </button>
          </span>
        )}
        <label className={styles.velocity} data-hint="How hard a touch plays: from where your finger lands on the key or pad, or one fixed level">
          Velocity
          <select
            value={velocity}
            onChange={(e) => services.commands.run('keys.velocity', e.target.value)}
            aria-label="Velocity"
          >
            {KEYS_VELOCITIES.map((v) => (
              <option key={v} value={v}>
                {VELOCITY_LABELS[v]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {page === 'piano' ? <Piano octave={octave} velocity={velocity} /> : <Pads velocity={velocity} />}
    </div>
  );
}
