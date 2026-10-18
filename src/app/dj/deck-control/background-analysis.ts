/**
 * The analysis of a song read by parts, made in the background while the song already sits on the deck (reading a
 * long song through takes a while). The deck is playable meanwhile and gets its beat grid, tempo and cue point after.
 */
import { deckGridOf } from '@core/dj/decks-math';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import type { DeckId, DeckState } from '../decks-api';
import type { DeckContext } from './context';
import type { Streams } from './streams';
import type { Transport } from './transport';

/** A deck parked within this many seconds of the start counts as "still at the start". */
const PARKED_AT_START_SEC = 0.05;

/** Progress is reported in whole percents, so the bar doesn't redraw for every fraction. */
const PROGRESS_STEPS = 100;

/** The background analysis of one set of decks. */
export interface BackgroundAnalysis {
  /** Starts analyzing the deck's song; `isStale` says the deck has moved on to something else. */
  start(deckId: DeckId, ref: SampleRef, title: string, isStale: () => boolean): void;
  /** Takes a finished analysis: sets the beat grid and tempo, and the cue point if it was left at the start. */
  apply(deckId: DeckId, analysis: TrackAnalysis): void;
}

/** Makes the background analysis of a set of decks. */
export function createBackgroundAnalysis(context: DeckContext, streams: Streams, transport: Transport): BackgroundAnalysis {
  const { deps, runtime, deckState, patchDeck } = context;

  function start(deckId: DeckId, ref: SampleRef, title: string, isStale: () => boolean): void {
    const deckRuntime = runtime[deckId];
    const control = new AbortController();
    deckRuntime.backgroundAnalysis = control;
    patchDeck(deckId, { analyzing: 0 });
    deps
      .analysis(ref, {
        signal: control.signal,
        priority: 'now',
        onProgress: (fraction) => {
          const progress = Math.floor(fraction * PROGRESS_STEPS) / PROGRESS_STEPS;
          if (!isStale() && progress !== deckState(deckId).analyzing) patchDeck(deckId, { analyzing: progress });
        },
      })
      .then((analysis) => {
        if (isStale()) return;
        deckRuntime.backgroundAnalysis = null;
        if (analysis) apply(deckId, analysis);
        else patchDeck(deckId, { analyzing: null });
      })
      .catch((error: unknown) => {
        if (isStale()) return;
        deckRuntime.backgroundAnalysis = null;
        patchDeck(deckId, { analyzing: null });
        const wasStopped = (error as { name?: string } | null)?.name === 'AbortError';
        if (wasStopped) return;
        const reason = error instanceof Error ? error.message : String(error);
        deps.toast(`Couldn’t analyze “${title}”: ${reason}`, 'error');
      });
  }

  function apply(deckId: DeckId, analysis: TrackAnalysis): void {
    const deckRuntime = runtime[deckId];
    const deck = deckState(deckId);
    deckRuntime.analysis = analysis;
    deckRuntime.grid = analysis.grid ? deckGridOf(analysis.grid) : null;
    const baseBpm = deckRuntime.grid?.bpm ?? null;
    const patch: Partial<DeckState> = {
      analyzing: null,
      baseBpm,
      bpm: baseBpm === null ? null : baseBpm * (1 + deck.pitch),
    };
    // The cue point is the first downbeat, unless the DJ has set it somewhere (or a saved one was found: those aren't at the start).
    const grid = deckRuntime.grid;
    const isCueAtStart = !!grid && deck.cuePoint === 0 && deck.hotCues.every((cue) => cue === null);
    if (grid && isCueAtStart) patch.cuePoint = Math.max(0, grid.firstDownbeat);
    patchDeck(deckId, patch);
    streams.refreshPins(deckId);
    // A deck still parked at the start goes to the first beat, as a deck whose analysis was ready when it loaded does.
    if (isCueAtStart && !deck.playing && deck.positionSec < PARKED_AT_START_SEC) transport.seek(deckId, deckState(deckId).cuePoint);
  }

  return { start, apply };
}
