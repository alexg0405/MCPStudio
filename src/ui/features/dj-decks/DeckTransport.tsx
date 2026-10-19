import type { RefObject } from 'react';
import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { formatPitch, PITCH_RANGES } from '@core/dj/decks-math';
import { Icon } from '../../controls/Icon';
import { deckTarget, PadButton, Slider } from './controls';
import { usePlatterGesture } from './deck-gestures';
import styles from './DjDecks.module.css';
import type { DeckView } from './use-decks';

/** The platter, the cue / play / sync / key-lock buttons and the pitch fader of a deck. */
export function DeckTransport({
  api,
  deckId,
  deck,
  hasGrid,
  platterRef,
}: {
  api: DecksApi;
  deckId: DeckId;
  deck: DeckView;
  /** The analysis found a steady beat (sync needs one). */
  hasGrid: boolean;
  /** The platter element the frame loop turns (`DeckScope`). */
  platterRef: RefObject<HTMLDivElement | null>;
}) {
  const hasSong = deck.song !== null;
  const platter = usePlatterGesture(api, deckId, hasSong);
  return (
    <div className={styles.transport}>
      <div
        ref={platterRef}
        data-dj-target={deckTarget(deckId, 'jog')}
        className={styles.platter}
        role="slider"
        tabIndex={0}
        aria-label={`Deck ${deckId} platter`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={0}
        data-hint="Platter: drag to scratch like a record, drag the outer ring to nudge the tempo, scroll to nudge"
        data-touch-own=""
        onPointerDown={platter.onPointerDown}
        onPointerMove={platter.onPointerMove}
        onPointerUp={platter.onPointerUp}
        onPointerCancel={platter.onPointerUp}
        onWheel={platter.onWheel}
      >
        <i className={styles.platterMark} />
      </div>
      <div className={styles.buttons}>
        <PadButton
          label={`Deck ${deckId} cue`}
          hint="Cue: paused, sets the cue point here (on the beat) and plays from it while held; playing, goes back to the cue point"
          disabled={!hasSong}
          target={deckTarget(deckId, 'cue')}
          className={styles.cue}
          onPointerDown={() => api.cueDown(deckId)}
          onPointerUp={() => api.cueUp(deckId)}
        >
          CUE
        </PadButton>
        <PadButton
          label={deck.playing ? `Pause deck ${deckId}` : `Play deck ${deckId}`}
          hint={deck.playing ? 'Pause this deck' : 'Play this deck (a synced deck starts on the beat)'}
          on={deck.playing}
          disabled={!hasSong}
          target={deckTarget(deckId, 'play')}
          className={styles.play}
          onClick={() => api.togglePlay(deckId)}
        >
          <Icon name={deck.playing ? 'pause' : 'play'} size={14} />
        </PadButton>
        <PadButton
          label={`Sync deck ${deckId}`}
          hint={
            hasGrid
              ? 'Sync: match the tempo and the beat of the other deck and stay with it (moving this deck’s pitch lets go)'
              : 'Sync needs a steady beat: this song has none the analysis could find'
          }
          on={deck.synced}
          disabled={!hasSong || !hasGrid}
          target={deckTarget(deckId, 'sync')}
          onClick={() => api.sync(deckId)}
        >
          SYNC
        </PadButton>
        <PadButton
          label={`Key lock deck ${deckId}`}
          hint="Key lock: change the tempo without changing the pitch (off, the pitch follows the speed like a record)"
          on={deck.keyLock}
          disabled={!hasSong}
          target={deckTarget(deckId, 'keylock')}
          onClick={() => api.setKeyLock(deckId, !deck.keyLock)}
        >
          KEY LOCK
        </PadButton>
      </div>
      <PitchFader api={api} deckId={deckId} deck={deck} />
    </div>
  );
}

/** The pitch readout, the vertical fader and the range buttons (±8, 16, 50 %). */
function PitchFader({ api, deckId, deck }: { api: DecksApi; deckId: DeckId; deck: DeckView }) {
  const range = deck.pitchRange;
  return (
    <div className={styles.pitch}>
      <span className={styles.pitchValue} data-hint="Pitch: how much faster (+) or slower (−) than the song's own tempo">
        {formatPitch(deck.pitch)}
      </span>
      <Slider
        vertical
        target={deckTarget(deckId, 'pitch')}
        className={styles.pitchSlider}
        value={deck.pitch}
        min={-range}
        max={range}
        reset={0}
        marks={[0]}
        label={`Deck ${deckId} pitch`}
        hint="Tempo of this deck: up is faster, down is slower."
        format={formatPitch}
        onChange={(v) => api.setPitch(deckId, v)}
      />
      <div className={styles.rangeRow} role="group" aria-label={`Deck ${deckId} pitch range`}>
        {PITCH_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            tabIndex={-1}
            className={`${styles.range} ${range === r ? styles.rangeOn : ''}`}
            aria-pressed={range === r}
            data-hint={`Pitch range ±${Math.round(r * 100)}%: how far the pitch fader goes`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => api.setPitchRange(deckId, r)}
          >
            {Math.round(r * 100)}
          </button>
        ))}
      </div>
    </div>
  );
}
