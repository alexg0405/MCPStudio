/**
 * Where each deck is right now. The player publishes its position once per render quantum; this carries it on to the
 * moment of asking (the audio clock), so a waveform or a platter drawn per frame moves smoothly.
 */
import type { DeckId } from '../decks-api';
import type { DeckContext } from './context';

/**
 * Right after a seek the player still publishes the old position until it has handled the message. For this long the
 * seek target (carried on at the playing speed) is reported instead.
 */
const SEEK_SETTLE_MS = 60;

/** How far (seconds) the audio clock may move the published position: it only closes the gap since the quantum was published. */
const MAX_CLOCK_CORRECTION_SEC = 0.5;

/** The position readers of one set of decks. */
export interface Positions {
  /** Where a deck is right now in seconds, as heard. */
  positionNow(deckId: DeckId): number;
  /** The player's stall flag (see `DecksApi.isStalled`): read from its published state, no React involved. */
  isStalled(deckId: DeckId): boolean;
  /** Writes `positionNow` into the deck's state (for a UI that reads the state, not the clock). */
  refreshPosition(deckId: DeckId): void;
}

export function createPositions(context: DeckContext): Positions {
  const { runtime, deckState, patchDeck, channelOf, now } = context;

  function positionNow(deckId: DeckId): number {
    const deck = deckState(deckId);
    const channel = channelOf(deckId);
    const graph = context.graph;
    if (!channel || !graph || !deck.song) return deck.positionSec;
    // A paused deck is where the last seek put it (a held platter moves it: that is read from the player).
    if (!deck.playing && !runtime[deckId].isTouching) return deck.positionSec;
    const durationSec = deck.song.durationSec;
    const nowMs = now();
    const { lastSeekAtMs, lastSeekToSec } = runtime[deckId];
    if (lastSeekAtMs > 0 && nowMs - lastSeekAtMs < SEEK_SETTLE_MS) {
      const sinceSeekSec = deck.playing ? ((nowMs - lastSeekAtMs) / 1000) * (1 + deck.pitch) : 0;
      return Math.max(0, Math.min(durationSec, lastSeekToSec + sinceSeekSec));
    }
    const snapshot = channel.snapshot();
    const rate = graph.ctx.sampleRate;
    let positionFrames = snapshot.pos;
    if (snapshot.playing && graph.ctx.state === 'running') {
      const maxCorrection = MAX_CLOCK_CORRECTION_SEC * rate;
      const framesSincePublished = graph.heardFrame() - snapshot.frame;
      const correction = Math.max(-maxCorrection, Math.min(maxCorrection, framesSincePublished));
      positionFrames += correction * snapshot.rate;
    }
    return Math.max(0, Math.min(durationSec, positionFrames / rate));
  }

  function isStalled(deckId: DeckId): boolean {
    const channel = channelOf(deckId);
    return !!channel && context.isLoaded(deckId) && channel.snapshot().stalled;
  }

  function refreshPosition(deckId: DeckId): void {
    patchDeck(deckId, { positionSec: positionNow(deckId), positionAt: now() });
  }

  return { positionNow, isStalled, refreshPosition };
}
