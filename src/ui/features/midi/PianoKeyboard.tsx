import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { keyName } from '@core/time/ppq';
import { useServices } from '../../services-context';
import styles from './PianoKeyboard.module.css';

const BLACK = new Set([1, 3, 6, 8, 10]);
const OCTAVES = 3;

/**
 * Plays the selected channel with the mouse (velocity from how low on the key you press) and lights
 * up whatever any input plays (MIDI keyboard, typing keyboard).
 */
export function PianoKeyboard() {
  const services = useServices();
  const [octave, setOctave] = useState(4);
  const [lit, setLit] = useState<ReadonlySet<number>>(() => new Set(services.live.heldKeys()));
  const down = useRef<number | null>(null);

  useEffect(
    () =>
      services.live.subscribe((e) => {
        if (e.type === 'noteOn' || e.type === 'noteOff') setLit(new Set(services.live.heldKeys()));
      }),
    [services],
  );
  useEffect(() => () => services.live.releaseAll('screen'), [services]);

  const first = octave * 12;
  const keys = Array.from({ length: OCTAVES * 12 + 1 }, (_, i) => first + i);
  const whites = keys.filter((k) => !BLACK.has(k % 12));

  const press = (key: number, e: ReactPointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const velocity = Math.max(0.2, Math.min(1, (e.clientY - r.top) / r.height));
    if (down.current !== null) services.live.noteOff(down.current, 0.5, { source: 'screen' });
    down.current = key;
    services.live.noteOn(key, velocity, { source: 'screen' });
  };
  const release = () => {
    if (down.current === null) return;
    services.live.noteOff(down.current, 0.5, { source: 'screen' });
    down.current = null;
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <button className={styles.oct} onClick={() => setOctave((o) => Math.max(0, o - 1))} data-hint="Octave down">
          −
        </button>
        <span className={styles.label}>{keyName(first)}</span>
        <button className={styles.oct} onClick={() => setOctave((o) => Math.min(8, o + 1))} data-hint="Octave up">
          +
        </button>
      </div>
      <div className={styles.keys} onPointerUp={release} onPointerLeave={release}>
        {whites.map((k) => (
          <div
            key={k}
            className={`${styles.white} ${lit.has(k) ? styles.on : ''}`}
            onPointerDown={(e) => press(k, e)}
            onPointerEnter={(e) => e.buttons === 1 && press(k, e)}
            data-hint={keyName(k)}
          >
            {k % 12 === 0 && <span className={styles.c}>{keyName(k)}</span>}
          </div>
        ))}
        <div className={styles.blacks}>
          {whites.map((k) => {
            const b = k + 1;
            if (!BLACK.has(b % 12) || b > keys[keys.length - 1]!)
              return <span key={`gap${k}`} className={styles.gap} />;
            return (
              <span key={`slot${k}`} className={styles.gap}>
                <div
                  className={`${styles.black} ${lit.has(b) ? styles.on : ''}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    press(b, e);
                  }}
                  onPointerEnter={(e) => e.buttons === 1 && press(b, e)}
                  data-hint={keyName(b)}
                />
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
