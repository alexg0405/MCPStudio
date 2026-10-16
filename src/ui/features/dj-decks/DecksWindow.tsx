import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canChooseOutput, listOutputs, onDevicesChange, type AudioOutput } from '@app/audio-devices';
import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { loadLibrary } from '@app/dj/library';
import { onFrame } from '../../frame-loop';
import { DeckPanel } from './DeckPanel';
import { useLearnMode } from './controls';
import styles from './DjDecks.module.css';
import { Mixer } from './Mixer';
import { useDecksApi, useDecksState } from './use-decks';

/** The headphone choice: which output the cue bus plays through. */
function Headphones({ api }: { api: DecksApi }) {
  const [outputs, setOutputs] = useState<AudioOutput[]>([]);
  const [value, setValue] = useState(() => {
    try {
      return globalThis.localStorage?.getItem('agstudio.dj.cueDevice') ?? '';
    } catch {
      return '';
    }
  });
  const [note, setNote] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () => void listOutputs().then((o) => live && setOutputs(o.outputs));
    refresh();
    const off = onDevicesChange(refresh);
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!canChooseOutput()) return null;
  const choose = async (id: string) => {
    setValue(id);
    setNote('');
    const ok = (await api.setCueDevice?.(id)) ?? false;
    if (!ok && id) setNote('That output isn’t available.');
  };
  return (
    <label className={styles.headphones} data-hint="Headphones: the output the CUE buttons play through, so you can listen to the next song before the room hears it">
      <span className={styles.label}>Headphones</span>
      <select value={value} onChange={(e) => void choose(e.target.value)} aria-label="Headphone output" data-hint="Pick the headphones (or another output) for the cue buttons; None keeps the cue silent">
        <option value="">None</option>
        {outputs.slice(1).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {note && <span className={styles.note}>{note}</span>}
    </label>
  );
}

/**
 * The Decks window: two decks (four on request) with their waveforms, platters and pads either side of the
 * mixer. Everything the decks do is `services.decks()`; this draws it and sends it the clicks.
 */
export function DecksWindow() {
  const api = useDecksApi();
  useEffect(() => void loadLibrary(), []);
  if (!api) return <div className={styles.decks}>Starting the decks…</div>;
  return <Loaded api={api} />;
}

function Loaded({ api }: { api: DecksApi }) {
  const count = useDecksState(api, (s) => s.deckCount);
  const learning = useLearnMode();
  // Meters: one frame callback reads every level and moves the bars (peak with a quick fall).
  const els = useRef<(HTMLElement | null)[]>([]);
  const held = useRef(new Float32Array(6));
  const meters = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => (el: HTMLElement | null) => {
        els.current[i] = el;
      }),
    [],
  );
  const read = useCallback(() => {
    const levels = new Float32Array(6);
    api.readLevels?.(levels);
    for (let i = 0; i < 6; i++) {
      const el = els.current[i];
      if (!el) continue;
      const v = Math.max(levels[i] as number, (held.current[i] as number) * 0.88);
      held.current[i] = v;
      // A square-root scale so a quiet deck still shows.
      el.style.transform = `scaleY(${Math.min(1, Math.sqrt(v))})`;
      el.dataset.hot = v > 0.99 ? '1' : '';
    }
  }, [api]);
  useEffect(() => onFrame(read), [read]);

  const left: DeckId[] = count === 4 ? ['A', 'C'] : ['A'];
  const right: DeckId[] = count === 4 ? ['B', 'D'] : ['B'];
  const order: DeckId[] = count === 4 ? ['A', 'C', 'D', 'B'] : ['A', 'B'];
  return (
    <div className={styles.decks} data-tour="dj-decks">
      <div className={styles.bar}>
        <span className={styles.label}>Decks</span>
        <div className={styles.seg} role="group" aria-label="How many decks to show">
          {([2, 4] as const).map((n) => (
            <button
              key={n}
              type="button"
              tabIndex={-1}
              className={count === n ? styles.segOn : styles.segItem}
              aria-pressed={count === n}
              data-hint={n === 2 ? 'Show two decks, A and B' : 'Show four decks: A, B, C and D'}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => api.setDeckCount?.(n)}
            >
              {n} decks
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        {learning && (
          <span className={styles.learnHint} role="status">
            Click any control to link it, even on an empty deck
          </span>
        )}
        <Headphones api={api} />
      </div>
      <div className={styles.stage} data-count={count}>
        <div className={styles.column}>
          {left.map((id) => (
            <DeckPanel key={id} api={api} id={id} />
          ))}
        </div>
        <Mixer api={api} order={order} meterRef={(i) => meters[i] as (el: HTMLElement | null) => void} />
        <div className={styles.column}>
          {right.map((id) => (
            <DeckPanel key={id} api={api} id={id} />
          ))}
        </div>
      </div>
    </div>
  );
}
