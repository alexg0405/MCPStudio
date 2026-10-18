/**
 * Transport: play, pause, seek, and the housekeeping when a deck stops or its song ends.
 */
import type { DeckId } from '../decks-api';
import { DECK_IDS } from '../decks-api';
import type { DeckContext } from './context';
import type { Positions } from './positions';
import type { Ticker } from './ticker';

/** A follower is told to line up with its master this long (ms) after the master jumped, once the jump has been heard. */
const FOLLOWER_ALIGN_DELAY_MS = 40;

/** The transport controls of one set of decks. */
export interface Transport {
  play(deckId: DeckId): void;
  pause(deckId: DeckId): void;
  togglePlay(deckId: DeckId): void;
  /** Jumps to a position in the song (seconds, clamped to the song). */
  seek(deckId: DeckId, sec: number): void;
  /** The player reached the end of the song. */
  ended(deckId: DeckId): void;
  /** Stops a deck's sound and everything riding on it (loop, sync, preview, platter) without touching its song. */
  stopDeck(deckId: DeckId): void;
  /** The followers of a deck that jumped move to its beat once the jump has been heard. */
  alignFollowersSoon(masterId: DeckId): void;
}

export function createTransport(context: DeckContext, positions: Positions, ticker: Ticker): Transport {
  const { deps, runtime, deckState, patchDeck, channelOf, now } = context;

  function play(deckId: DeckId): void {
    runtime[deckId].isPreviewingCue = false;
    if (!context.isLoaded(deckId) || deckState(deckId).playing) return;
    void deps.resume().catch(() => {});
    channelOf(deckId)?.send({ t: 'play', on: true });
    patchDeck(deckId, { playing: true, positionAt: now() });
    ticker.start();
  }

  function pause(deckId: DeckId): void {
    if (!deckState(deckId).playing) return;
    runtime[deckId].isPreviewingCue = false;
    const positionSec = positions.positionNow(deckId);
    channelOf(deckId)?.send({ t: 'play', on: false });
    patchDeck(deckId, { playing: false, positionSec, positionAt: now() });
  }

  function togglePlay(deckId: DeckId): void {
    if (deckState(deckId).playing) pause(deckId);
    else play(deckId);
  }

  function seek(deckId: DeckId, sec: number): void {
    if (!context.isLoaded(deckId)) return;
    const targetSec = Math.max(0, Math.min(context.durationOf(deckId), sec));
    const targetFrame = targetSec * context.sampleRate();
    // The window moves to where the playhead is going before the player is told (a song in memory needs no wait).
    runtime[deckId].stream?.moveTo(targetFrame);
    channelOf(deckId)?.send({ t: 'seek', pos: targetFrame });
    runtime[deckId].lastSeekAtMs = now();
    runtime[deckId].lastSeekToSec = targetSec;
    patchDeck(deckId, { positionSec: targetSec, positionAt: now() });
    alignFollowersSoon(deckId);
  }

  function alignFollowersSoon(masterId: DeckId): void {
    for (const followerId of DECK_IDS) {
      if (runtime[followerId].syncMaster !== masterId || !deckState(followerId).playing) continue;
      setTimeout(() => channelOf(followerId)?.send({ t: 'align' }), FOLLOWER_ALIGN_DELAY_MS);
    }
  }

  function ended(deckId: DeckId): void {
    runtime[deckId].isPreviewingCue = false;
    patchDeck(deckId, { playing: false, positionSec: context.durationOf(deckId), positionAt: now() });
  }

  function stopDeck(deckId: DeckId): void {
    const channel = channelOf(deckId);
    channel?.send({ t: 'play', on: false });
    channel?.send({ t: 'noloop' });
    channel?.send({ t: 'sync', sync: null });
    const deckRuntime = runtime[deckId];
    deckRuntime.isPreviewingCue = false;
    deckRuntime.isTouching = false;
    context.heldPlatters.delete(deckId);
    if (deckRuntime.scratchTimer) clearTimeout(deckRuntime.scratchTimer);
    deckRuntime.scratchTimer = null;
  }

  return { play, pause, togglePlay, seek, ended, stopDeck, alignFollowersSoon };
}
