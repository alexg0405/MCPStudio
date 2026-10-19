import { useEffect, useRef } from 'react';
import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { onFrame } from '../../frame-loop';
import { Icon } from '../../controls/Icon';
import { keyBadge } from '../dj/dj-view';
import { useLearnMode } from './controls';
import { DeckHeader } from './DeckHeader';
import { HotCuePads, LoopPads } from './DeckPads';
import { DeckTransport } from './DeckTransport';
import { useOverviewSeek, useSongDrop } from './deck-gestures';
import styles from './DjDecks.module.css';
import { DeckScope } from './scope';
import { useDeck } from './use-decks';

/**
 * One deck: its header, the two waveforms, the clock, the platter and buttons, the hot cues and the loop row.
 * The state it shows as React comes from `useDeck`; the waveforms, platter, clock and the "Loading…" note are drawn
 * on the frame loop (`DeckScope`), so a playing deck causes no React renders.
 */
export function DeckPanel({ api, id }: { api: DecksApi; id: DeckId }) {
  const deck = useDeck(api, id);
  const zoomCanvas = useRef<HTMLCanvasElement>(null);
  const overviewCanvas = useRef<HTMLCanvasElement>(null);
  const platter = useRef<HTMLDivElement>(null);
  const elapsedTime = useRef<HTMLSpanElement>(null);
  const remainingTime = useRef<HTMLSpanElement>(null);
  const stallNote = useRef<HTMLDivElement>(null);

  // The waveforms, the platter, the clock and the "Loading…" note are drawn on the frame loop, only while this panel exists.
  useEffect(() => {
    if (!zoomCanvas.current || !overviewCanvas.current) return;
    const scope = new DeckScope(api, id, {
      zoom: zoomCanvas.current,
      overview: overviewCanvas.current,
      platter: platter.current,
      time: elapsedTime.current,
      remaining: remainingTime.current,
      stall: stallNote.current,
    });
    return onFrame((now) => scope.frame(now));
  }, [api, id]);

  const hasSong = deck.song !== null;
  const isLearning = useLearnMode();
  const analysis = api.analysisOf?.(id) ?? null;
  const overview = useOverviewSeek(api, id, deck.song);
  const drop = useSongDrop(id);

  return (
    <section className={styles.deck} data-deck={id} onDragOver={drop.onDragOver} onDrop={drop.onDrop} aria-label={`Deck ${id}`}>
      <DeckHeader api={api} deckId={id} deck={deck} badge={keyBadge(analysis)} isLearning={isLearning} />

      <div className={styles.scopes}>
        <canvas ref={zoomCanvas} className={styles.zoom} aria-hidden />
        <div ref={stallNote} className={styles.stall} hidden data-hint="Loading this part of the song from disk; it plays as soon as it's ready">
          <i className={styles.stallDot} aria-hidden />
          <span>Loading…</span>
        </div>
        {!hasSong && <EmptyDeckNote deckId={id} isLoading={deck.loading} />}
      </div>
      <canvas
        ref={overviewCanvas}
        className={styles.overview}
        role="slider"
        aria-label={`Deck ${id} position`}
        aria-valuemin={0}
        aria-valuemax={deck.song?.durationSec ?? 0}
        aria-valuenow={0}
        data-hint={`Whole song: click or drag to jump to a place in deck ${id}`}
        data-touch-own=""
        onPointerDown={overview.onPointerDown}
        onPointerMove={overview.onPointerMove}
        onPointerUp={overview.onPointerUp}
      />
      <div className={styles.clock}>
        <span ref={elapsedTime} className={styles.time} data-hint="Time into the song (minutes:seconds)" />
        <span ref={remainingTime} className={styles.remaining} data-hint="Time left in the song" />
      </div>

      <DeckTransport api={api} deckId={id} deck={deck} hasGrid={!!analysis?.grid} platterRef={platter} />
      <HotCuePads api={api} deckId={id} deck={deck} />
      <LoopPads api={api} deckId={id} deck={deck} />
    </section>
  );
}

/** What an empty deck says over its waveform: loading, or what to do next. */
function EmptyDeckNote({ deckId, isLoading }: { deckId: DeckId; isLoading: boolean }) {
  return (
    <div className={styles.emptyDeck}>
      {isLoading ? (
        'Loading…'
      ) : (
        <>
          <Icon name="note" size={18} />
          <span>Drop a song here, or right-click one in the Music list and choose Load to deck {deckId}.</span>
        </>
      )}
    </div>
  );
}
