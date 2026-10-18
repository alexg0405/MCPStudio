import { useEffect } from 'react';
import { useStore } from 'zustand';
import { djControllers } from '@app/dj/controllers';
import type { DecksApi } from '@app/dj/decks-api';
import { useServices } from '../../services-context';
import styles from './Controllers.module.css';
import { TEST_EMPTY } from './view';

/** Incoming messages and what they did, plus a peek at the decks. */
export function TestTab() {
  const dj = djControllers(useServices());
  const log = useStore(dj.monitor, (s) => s.log);
  // Messages are only kept while a test view is watching.
  useEffect(() => dj.watch(), [dj]);
  return (
    <div className={styles.body}>
      <DecksPeek />
      <div className={styles.bar}>
        <span className={styles.dim}>{log.length ? `Last ${log.length} messages` : ''}</span>
        <span className={styles.spacer} />
        <button className={styles.small} onClick={() => dj.clearLog()} disabled={!log.length} data-hint="Empty the list">
          Clear
        </button>
      </div>
      {log.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyText}>{TEST_EMPTY}</div>
        </div>
      ) : (
        <div className={styles.log}>
          {log.map((entry) => (
            <div key={entry.n} className={styles.logRow}>
              <span>{entry.text}</span>
              <span className={entry.did === 'Not mapped' ? styles.logNone : styles.logDid}>→ {entry.did}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The decks' state, once the decks are ready. */
function DecksPeek() {
  const dj = djControllers(useServices());
  const status = useStore(dj.store, (s) => s.decks);
  const decks = dj.liveDecks;
  return status === 'ready' && decks ? <DecksPeekLines decks={decks} /> : null;
}

/** One line per deck (A and B), and the crossfader. */
function DecksPeekLines({ decks }: { decks: DecksApi }) {
  const state = useStore(decks.store);
  return (
    <div className={styles.state}>
      {(['A', 'B'] as const).map((id) => {
        const deck = state.decks[id];
        return (
          <span key={id}>
            Deck {id}: {deck.playing ? 'playing' : 'paused'}
            {deck.song ? ` · ${deck.song.title}` : ' · empty'} · volume {Math.round(deck.volume * 100)}% · pitch {(deck.pitch * 100).toFixed(1)}%
          </span>
        );
      })}
      <span>Crossfader {Math.round(state.crossfader * 100)}%</span>
    </div>
  );
}
