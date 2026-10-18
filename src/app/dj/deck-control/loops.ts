/**
 * Loops and beat jumps on the beat grid: loop in/out by hand, auto loops of a chosen number of beats, halving and
 * doubling, and jumping forward or back by whole beats.
 */
import {
  autoLoopSpan,
  beatJumpTarget,
  loopBeats,
  manualLoopSpan,
  resizeLoop,
  shiftLoop,
  snapToGrid,
} from '@core/dj/decks-math';
import type { DeckId, DeckState } from '../decks-api';
import type { DeckContext } from './context';
import type { Positions } from './positions';
import type { Streams } from './streams';
import type { Transport } from './transport';

/** A manual loop-in point snaps to the nearest sixteenth note (a quarter of a beat). */
const LOOP_IN_SNAP_BEATS = 0.25;

/** An auto loop of the size that is looping already is the same one (beat counts match within this). */
const SAME_LOOP_SIZE_TOLERANCE_BEATS = 1e-6;

/** The beat jump buttons offer between 1 and this many beats. */
const MIN_BEAT_JUMP_BEATS = 1;
const MAX_BEAT_JUMP_BEATS = 32;

/** The loop and beat jump controls of one set of decks. */
export interface Loops {
  loopIn(deckId: DeckId): void;
  /** Sets the loop's end and starts it; pressed again, exits it; pressed on an ended loop, starts it again (reloop). */
  loopOut(deckId: DeckId): void;
  /** Loops `beats` beats from the playhead; pressing the size that is looping already exits it. */
  autoLoop(deckId: DeckId, beats: number): void;
  loopHalve(deckId: DeckId): void;
  loopDouble(deckId: DeckId): void;
  exitLoop(deckId: DeckId): void;
  /** Jumps `beats` forward (negative: back), keeping the phase; an active loop moves with the jump. */
  beatJumpBy(deckId: DeckId, beats: number): void;
  /** Sets how many beats the jump buttons (and auto loops) use. */
  setBeatJump(deckId: DeckId, beats: number): void;
}

/** Makes the loop and beat jump controls of a set of decks. */
export function createLoops(context: DeckContext, positions: Positions, streams: Streams, transport: Transport): Loops {
  const { runtime, deckState, patchDeck, channelOf, durationOf } = context;
  const loopOf = (deckId: DeckId) => deckState(deckId).loop;

  /** Stores the loop and tells the window and the player about it (or that there is none running). */
  function setLoopState(deckId: DeckId, loop: DeckState['loop']): void {
    patchDeck(deckId, { loop });
    // The loop's audio stays in the window while it is on (before the player is told, so it never waits for it).
    streams.refreshPins(deckId);
    if (loop?.active) streams.sendLoop(deckId, loop.startSec, loop.endSec);
    else channelOf(deckId)?.send({ t: 'noloop' });
  }

  function loopIn(deckId: DeckId): void {
    if (!context.isLoaded(deckId)) return;
    const startSec = Math.max(0, snapToGrid(positions.positionNow(deckId), runtime[deckId].grid, LOOP_IN_SNAP_BEATS));
    patchDeck(deckId, { loop: { startSec, endSec: startSec, active: false } });
    streams.refreshPins(deckId);
    channelOf(deckId)?.send({ t: 'noloop' });
  }

  function loopOut(deckId: DeckId): void {
    const loop = loopOf(deckId);
    if (!context.isLoaded(deckId)) return;
    if (!loop) return loopIn(deckId);
    if (loop.active) return exitLoop(deckId);
    const hasEnd = loop.endSec > loop.startSec;
    if (hasEnd) return setLoopState(deckId, { ...loop, active: true });
    const span = manualLoopSpan(loop.startSec, positions.positionNow(deckId), runtime[deckId].grid);
    setLoopState(deckId, { ...span, active: true });
  }

  function autoLoop(deckId: DeckId, beats: number): void {
    if (!context.isLoaded(deckId)) return;
    const loop = loopOf(deckId);
    const grid = runtime[deckId].grid;
    const isSameSizeLooping = loop?.active && Math.abs(loopBeats(loop, grid) - beats) < SAME_LOOP_SIZE_TOLERANCE_BEATS;
    if (isSameSizeLooping) return exitLoop(deckId);
    const span = autoLoopSpan(positions.positionNow(deckId), beats, grid);
    const endSec = Math.min(durationOf(deckId), span.endSec);
    setLoopState(deckId, { startSec: span.startSec, endSec, active: true });
  }

  function resize(deckId: DeckId, factor: 0.5 | 2): void {
    const loop = loopOf(deckId);
    if (!loop || loop.endSec <= loop.startSec) return;
    const span = resizeLoop(loop, factor, runtime[deckId].grid, durationOf(deckId));
    setLoopState(deckId, { ...span, active: loop.active });
  }

  function exitLoop(deckId: DeckId): void {
    const loop = loopOf(deckId);
    if (!loop?.active) return;
    setLoopState(deckId, { ...loop, active: false });
  }

  function beatJumpBy(deckId: DeckId, beats: number): void {
    if (!context.isLoaded(deckId)) return;
    const fromSec = positions.positionNow(deckId);
    const toSec = beatJumpTarget(fromSec, beats, runtime[deckId].grid, durationOf(deckId));
    const loop = loopOf(deckId);
    // A loop that is on moves with the jump.
    if (loop?.active) setLoopState(deckId, { ...shiftLoop(loop, toSec - fromSec, durationOf(deckId)), active: true });
    transport.seek(deckId, toSec);
  }

  function setBeatJump(deckId: DeckId, beats: number): void {
    patchDeck(deckId, { beatJump: Math.max(MIN_BEAT_JUMP_BEATS, Math.min(MAX_BEAT_JUMP_BEATS, Math.round(beats))) });
  }

  return {
    loopIn,
    loopOut,
    autoLoop,
    loopHalve: (deckId) => resize(deckId, 0.5),
    loopDouble: (deckId) => resize(deckId, 2),
    exitLoop,
    beatJumpBy,
    setBeatJump,
  };
}
