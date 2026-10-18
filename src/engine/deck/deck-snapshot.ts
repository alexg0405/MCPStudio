/**
 * What a deck publishes about itself (see `DS` in `deck-id.ts`) and how to read it back. The player writes it each
 * render quantum; the main thread (waveforms, the platter) and a synced follower deck read it. Kept apart from the
 * player (`deck.kernel.ts`) so the main thread doesn't load the DSP to read a number.
 */
import { DS } from './deck-id';

/** A consistent copy of a deck's published state. Positions are frames of the song; `frame` is a context frame. */
export interface DeckSnapshot {
  /** Song position at the first frame of the quantum. */
  pos: number;
  /** Context frame of that quantum. */
  frame: number;
  /** Song frames per output frame right now (tempo, nudge and scratch included). */
  rate: number;
  /** The same without a scratch: what a follower deck matches. */
  tempoRate: number;
  playing: boolean;
  scratching: boolean;
  loopWraps: number;
  /** Follower: beat-phase error to the master in beats; 0 when not following. */
  syncError: number;
  syncLocked: boolean;
  /** Waiting for audio that isn't loaded yet. */
  stalled: boolean;
}

/** How many times a read is retried when the writer is mid-update, before giving up and keeping what was read. */
const MAX_READ_TRIES = 8;

/** Reads a published state consistently (the writer may be mid-update: its sequence counter is odd while it writes). */
export function readDeckState(state: Float64Array, seq: Int32Array, out: DeckSnapshot): void {
  for (let tries = 0; tries < MAX_READ_TRIES; tries++) {
    const before = Atomics.load(seq, 0);
    out.pos = state[DS.pos] as number;
    out.frame = state[DS.frame] as number;
    out.rate = state[DS.rate] as number;
    out.tempoRate = state[DS.tempoRate] as number;
    out.playing = state[DS.playing] === 1;
    out.scratching = state[DS.scratching] === 1;
    out.loopWraps = state[DS.loopWraps] as number;
    out.syncError = state[DS.syncError] as number;
    out.syncLocked = state[DS.syncLocked] === 1;
    out.stalled = state[DS.stalled] === 1;
    const wasStable = (before & 1) === 0 && Atomics.load(seq, 0) === before;
    if (wasStable) return;
  }
}

/** A snapshot to read into (made once, reused). */
export const newSnapshot = (): DeckSnapshot => ({
  pos: 0,
  frame: 0,
  rate: 0,
  tempoRate: 0,
  playing: false,
  scratching: false,
  loopWraps: 0,
  syncError: 0,
  syncLocked: false,
  stalled: false,
});
