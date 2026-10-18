/**
 * The jog wheel: the rim nudges a playing deck, a paused deck is turned by hand, and a held platter scratches.
 */
import { nudgeBend, REV_SEC, scratchRate } from '@core/dj/decks-math';
import type { DeckId } from '../decks-api';
import type { DeckContext } from './context';
import type { Positions } from './positions';
import type { Transport } from './transport';

/** Two jog events closer together than this (ms) are one movement: their gap tells how fast the wheel turns. */
const JOG_CONTINUOUS_MS = 200;

/** The time step (seconds) assumed for the first event of a movement: one frame at 60 Hz. */
const FIRST_JOG_STEP_SEC = 0.016;

/** A scratch with no new movement for this long (ms) brings the record to a stop. */
const SCRATCH_STOP_AFTER_MS = 60;

/** After the record stopped, a platter nobody told us was let go is released this much later (ms). */
const SCRATCH_RELEASE_AFTER_MS = 400;

/** How long after a touch ends (ms) the position is read back from the player, once it has settled. */
const POSITION_READBACK_AFTER_TOUCH_MS = 30;

/** The jog wheel controls of one set of decks. */
export interface Jog {
  /** Jog wheel: `delta` in revolutions; a touched platter scratches, the rim nudges a playing deck. */
  jog(deckId: DeckId, delta: number, mode: 'nudge' | 'scratch'): void;
  /** The platter was touched (scratch mode on, record held) or let go. */
  jogTouch(deckId: DeckId, isTouching: boolean): void;
}

/** Makes the jog wheel controls of a set of decks. */
export function createJog(context: DeckContext, positions: Positions, transport: Transport): Jog {
  const { runtime, deckState, channelOf, now } = context;

  /** Seconds since the previous jog event of this deck, or a default step for the first of a movement. */
  function stepSecSinceLastJog(deckId: DeckId): number {
    const deckRuntime = runtime[deckId];
    const nowMs = now();
    const isContinuing = deckRuntime.lastJogAtMs > 0 && nowMs - deckRuntime.lastJogAtMs < JOG_CONTINUOUS_MS;
    const stepSec = isContinuing ? (nowMs - deckRuntime.lastJogAtMs) / 1000 : FIRST_JOG_STEP_SEC;
    deckRuntime.lastJogAtMs = nowMs;
    return stepSec;
  }

  /**
   * The platter stops when it stops moving; a touch that ended without being told lets go a moment later (unless the
   * platter is really held, or the cue is being previewed).
   */
  function letGoWhenStill(deckId: DeckId): void {
    const deckRuntime = runtime[deckId];
    if (deckRuntime.scratchTimer) clearTimeout(deckRuntime.scratchTimer);
    deckRuntime.scratchTimer = setTimeout(() => {
      channelOf(deckId)?.send({ t: 'scratchRate', rate: 0 });
      deckRuntime.scratchTimer = setTimeout(() => {
        if (!deckRuntime.isTouching || deckRuntime.isPreviewingCue || context.heldPlatters.has(deckId)) return;
        deckRuntime.isTouching = false;
        channelOf(deckId)?.send({ t: 'scratch', on: false });
        positions.refreshPosition(deckId);
      }, SCRATCH_RELEASE_AFTER_MS);
    }, SCRATCH_STOP_AFTER_MS);
  }

  function jog(deckId: DeckId, delta: number, mode: 'nudge' | 'scratch'): void {
    const deck = deckState(deckId);
    const channel = channelOf(deckId);
    if (!deck.song || !channel || !Number.isFinite(delta)) return;
    const deckRuntime = runtime[deckId];
    const stepSec = stepSecSinceLastJog(deckId);
    if (mode === 'scratch') {
      if (!deckRuntime.isTouching) {
        // A drag without a touch event (a mouse, a controller that doesn't send one): hold for the drag.
        deckRuntime.isTouching = true;
        channel.send({ t: 'scratch', on: true });
      }
      channel.send({ t: 'scratchRate', rate: scratchRate(delta, stepSec) });
      letGoWhenStill(deckId);
    } else if (deck.playing) {
      channel.send({ t: 'nudge', bend: nudgeBend(delta, stepSec) });
    } else {
      // Paused: the rim turns the song by hand, a revolution being REV_SEC.
      transport.seek(deckId, positions.positionNow(deckId) + delta * REV_SEC);
    }
  }

  function jogTouch(deckId: DeckId, isTouching: boolean): void {
    const deckRuntime = runtime[deckId];
    const channel = channelOf(deckId);
    if (!deckState(deckId).song || !channel) return;
    if (isTouching) {
      context.heldPlatters.add(deckId);
      deckRuntime.isTouching = true;
      deckRuntime.lastJogAtMs = 0;
      channel.send({ t: 'scratch', on: true });
      channel.send({ t: 'scratchRate', rate: 0 });
      return;
    }
    context.heldPlatters.delete(deckId);
    if (deckRuntime.scratchTimer) clearTimeout(deckRuntime.scratchTimer);
    deckRuntime.scratchTimer = null;
    deckRuntime.isTouching = false;
    channel.send({ t: 'scratch', on: false });
    setTimeout(() => positions.refreshPosition(deckId), POSITION_READBACK_AFTER_TOUCH_MS);
    transport.alignFollowersSoon(deckId);
  }

  return { jog, jogTouch };
}
