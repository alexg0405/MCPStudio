import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { Icon } from '../../controls/Icon';
import type { keyBadge } from '../dj/dj-view';
import { deckTarget } from './controls';
import styles from './DjDecks.module.css';
import { useLoadMenu } from './deck-gestures';
import type { DeckView } from './use-decks';

/** What the tempo readout's tooltip says: the tempo now, or why there is none. */
function tempoHint(deck: DeckView): string {
  if (deck.bpm !== null) return `Tempo now: ${deck.bpm.toFixed(1)} BPM (the song’s own is ${deck.baseBpm?.toFixed(1)} BPM)`;
  if (deck.analyzing !== null) return 'Tempo: this long song is still being analyzed (sync and beat snapping start when it is done)';
  return 'Tempo: this song has no steady beat to read';
}

/** The line under the title: what the deck is busy with, or the artist. */
function subtitle(deck: DeckView): string {
  if (deck.loading) return 'Loading and analyzing…';
  if (deck.analyzing !== null) return `Finding the beat… ${Math.round(deck.analyzing * 100)} %`;
  return deck.song?.artist ?? '';
}

/** The top of a deck: its letter, the song's title, tempo and key, and the Load and Eject buttons. */
export function DeckHeader({
  api,
  deckId,
  deck,
  badge,
  isLearning,
}: {
  api: DecksApi;
  deckId: DeckId;
  deck: DeckView;
  badge: ReturnType<typeof keyBadge>;
  /** MIDI learn is on: an empty deck's Eject stays pickable. */
  isLearning: boolean;
}) {
  const hasSong = deck.song !== null;
  const openLoadMenu = useLoadMenu(deckId);
  return (
    <header className={styles.deckHead}>
      <span className={styles.letter} data-hint={`Deck ${deckId}`}>
        {deckId}
      </span>
      <div className={styles.titles}>
        <b className={styles.songTitle}>{deck.song ? deck.song.title : `Deck ${deckId} is empty`}</b>
        <span className={styles.artist}>{subtitle(deck)}</span>
      </div>
      <span className={styles.lcd} data-hint={tempoHint(deck)}>
        {deck.bpm === null ? '–' : deck.bpm.toFixed(1)}
        <small>BPM</small>
      </span>
      <span className={styles.keyBadge} style={badge.color ? { background: badge.color, color: 'var(--ag-on-light)' } : undefined} data-hint={badge.hint}>
        {badge.text}
      </span>
      <button
        type="button"
        data-dj-target={deckTarget(deckId, 'load')}
        className={styles.load}
        aria-label={`Load a song on deck ${deckId}`}
        data-hint={`Choose a song from your music library to put on deck ${deckId}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => void openLoadMenu(e)}
      >
        Load…
      </button>
      <button
        type="button"
        data-dj-target={deckTarget(deckId, 'eject')}
        className={`${styles.eject} ${!hasSong && isLearning ? styles.idle : ''}`}
        disabled={!hasSong && !isLearning}
        aria-disabled={(!hasSong && isLearning) || undefined}
        aria-label={`Eject deck ${deckId}`}
        data-hint={`Take the song off deck ${deckId} (stops it)`}
        onClick={() => api.eject(deckId)}
      >
        <Icon name="close" size={11} />
      </button>
    </header>
  );
}
