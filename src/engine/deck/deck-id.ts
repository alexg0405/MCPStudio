/** Processor name of a DJ deck's player (kept apart so the main thread needn't load the worklet). */
export const DECK_ID = 'agstudio.deck';

/**
 * Slots of a deck's shared state (a Float64Array over a SharedArrayBuffer). The audio thread publishes where the
 * deck is at the start of each render quantum; the main thread (waveforms, the platter) and a synced follower deck
 * read it, under a sequence lock (an Int32 at byte 0, odd while it is being written).
 */
export const DS = {
  /** Bytes 0–7: the Int32 sequence counter (slot 0 itself is never used as a number). */
  seq: 0,
  /** Song position in frames (fractional) at the first frame of the quantum. */
  pos: 1,
  /** Context frame (currentFrame) of that quantum. */
  frame: 2,
  /** Frames of song per output frame right now: tempo, nudge and scratch included (negative backwards). */
  rate: 3,
  /** The same without a scratch: what a follower deck matches. */
  tempoRate: 4,
  /** 1 while the deck plays (or is scratched). */
  playing: 5,
  /** 1 while the platter is held and scratched. */
  scratching: 6,
  /** Loop wraps so far. */
  loopWraps: 7,
  /** Follower: the beat-phase error to the master in beats (positive = ahead); 0 when not following. */
  syncError: 8,
  /** Follower: 1 while locked to a playing master. */
  syncLocked: 9,
} as const;
export const DECK_STATE_SLOTS = 16;

/** What the worklet is told (main thread to audio thread). */
export type DeckMessage =
  | { t: 'song'; channels: SharedArrayBuffer[]; frames: number; sampleRate: number }
  | { t: 'eject' }
  | { t: 'play'; on: boolean }
  /** Jump to a position (frames), crossfading over a couple of milliseconds. */
  | { t: 'seek'; pos: number }
  /** Tempo ratio (1 + pitch) and key lock. */
  | { t: 'tempo'; rate: number; keyLock: boolean }
  /** Temporary tempo bend (a fraction), held for 120 ms unless refreshed. */
  | { t: 'nudge'; bend: number }
  /** The platter is held (scratching) or let go. */
  | { t: 'scratch'; on: boolean }
  /** Scratch speed (1 = normal, negative = backwards) while the platter is held. */
  | { t: 'scratchRate'; rate: number }
  /** A loop in frames (start, length). */
  | { t: 'loop'; start: number; length: number }
  | { t: 'noloop' }
  | { t: 'sync'; sync: SyncSpec | null }
  /** Jump a following deck to the master's beat (exactly, at the next render quantum). */
  | { t: 'align' }
  /** Answered with `pong` once everything sent before it has been handled (a barrier for offline renders and tests). */
  | { t: 'ping'; id: number }
  | { t: 'dispose' };

/** Following another deck (all positions in frames of each song). */
export interface SyncSpec {
  /** The master's shared state. */
  master: SharedArrayBuffer;
  /** This deck's tempo ratio per master tempo ratio: masterBase × masterMultiple / (selfBase × selfMultiple). */
  ratio: number;
  selfFirst: number;
  selfBeat: number;
  masterFirst: number;
  masterBeat: number;
  /**
   * Tracked beats (frames of the song, ascending) of a song whose tempo drifts: when a deck has them, its beat phase and
   * tempo come from the beats around its position (`BeatMap`) instead of `*First`/`*Beat`. The first downbeat is still
   * `*First`, so beat 0 is the same one either way. Absent: the fixed grid.
   */
  selfBeats?: Float64Array;
  masterBeats?: Float64Array;
  /** The tempo multiple the follower matches (½, 1, 2); `selfBeat` already holds it, tracked beats need it. Default 1. */
  selfMult?: number;
}

/** What the worklet tells the main thread. */
export type DeckEvent = { t: 'ended' } | { t: 'pong'; id: number };
