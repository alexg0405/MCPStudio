/**
 * The "Auto" audio buffer: the smallest buffer the machine plays the song with, found by watching playback.
 *
 * A small buffer answers fastest (a key you press is heard sooner, a started song is heard sooner) but leaves the
 * audio thread less room: a song that is too busy for it falls behind and crackles. The engine measures that each
 * second while playing (`stats().keepUp`: the audio clock against the wall clock, 1 = in time). This is the
 * decision part, with no timers and no engine, so it can be tested with plain numbers:
 *
 *  - two seconds in a row below `STRUGGLE`, or one second below `COLLAPSE`: one step up (small → medium → large);
 *  - never two steps within `MIN_STEP_GAP_MS`, and the seconds right after a step are not counted (a new engine
 *    is still starting its sounds);
 *  - after `CLEAN_SECONDS` of playing with nothing lost, one step back down is tried (a lighter song, a quieter
 *    machine); if that struggles within `TRIAL_SECONDS` it goes back up and no further try is made for
 *    `BLOCK_DOWN_MS`, so it settles instead of flapping.
 *
 * The size it is at is remembered (prefs `autoBufferSize`), so the next session starts there.
 */
import type { AudioBufferSize } from './stores/prefs';

export const BUFFER_SIZES: readonly AudioBufferSize[] = ['small', 'medium', 'large'];

/** A second that keeps up less than this (3% of the sound lost) counts as struggling. */
export const STRUGGLE = 0.97;
/** A second below this is bad enough to step up at once. */
export const COLLAPSE = 0.85;
/** A second at or above this lost nothing worth mentioning. */
export const CLEAN = 0.995;
export const STRUGGLE_SECONDS = 2;
export const MIN_STEP_GAP_MS = 8_000;
/** Seconds after a step that are not counted (a new engine loading its sounds). */
export const SETTLE_SECONDS = 2;
/** Seconds of clean playing before a smaller buffer is tried (a MIDI keyboard or the typing piano shortens it). */
export const CLEAN_SECONDS = 180;
export const CLEAN_SECONDS_LIVE = 60;
/** A smaller buffer that struggles within this many seconds goes back up, and the size is kept for a while. */
export const TRIAL_SECONDS = 30;
export const BLOCK_DOWN_MS = 30 * 60_000;

export class AutoBuffer {
  private struggling = 0;
  private clean = 0;
  private settle = 0;
  private lastStepAt = Number.NEGATIVE_INFINITY;
  /** Seconds of playing since the last step down, while that step is still on trial. */
  private trial: number | null = null;
  private blockedUntil = Number.NEGATIVE_INFINITY;

  constructor(
    /** The size in use (the engine runs with it). */
    public size: AudioBufferSize = 'small',
  ) {}

  /** The size the engine now runs with (after a step, or when the choice changes from outside). */
  stepped(size: AudioBufferSize): void {
    this.size = size;
    this.struggling = 0;
    this.clean = 0;
    this.settle = SETTLE_SECONDS;
  }

  /** Playback stopped or started again: the second that was being counted is gone. */
  restart(): void {
    this.struggling = 0;
    this.settle = Math.max(this.settle, 1);
  }

  /**
   * One reading, once a second while playing. `keepUp` is the share of the last second the audio clock advanced
   * (undefined: not measured yet), `atMs` a clock in ms, `live` whether a MIDI keyboard or the typing piano is in use.
   * Returns the size to switch to, or null to stay.
   */
  observe(keepUp: number | undefined, atMs: number, live = false): AudioBufferSize | null {
    if (keepUp === undefined) return null;
    if (this.settle > 0) {
      this.settle--;
      return null;
    }
    const at = BUFFER_SIZES.indexOf(this.size);
    const struggled = keepUp < STRUGGLE;
    this.struggling = struggled ? this.struggling + 1 : 0;
    this.clean = keepUp >= CLEAN ? this.clean + 1 : 0;
    if (this.trial !== null) this.trial++;
    const canStep = atMs - this.lastStepAt >= MIN_STEP_GAP_MS;

    if ((this.struggling >= STRUGGLE_SECONDS || keepUp < COLLAPSE) && at < BUFFER_SIZES.length - 1 && canStep) {
      // A smaller size that did not work out: it goes back up and stays up for a while.
      if (this.trial !== null && this.trial <= TRIAL_SECONDS) this.blockedUntil = atMs + BLOCK_DOWN_MS;
      this.trial = null;
      return this.move(at + 1, atMs);
    }
    if (this.trial !== null && this.trial > TRIAL_SECONDS) this.trial = null;
    if (at > 0 && this.clean >= (live ? CLEAN_SECONDS_LIVE : CLEAN_SECONDS) && atMs >= this.blockedUntil && canStep) {
      const next = this.move(at - 1, atMs);
      this.trial = 0;
      return next;
    }
    return null;
  }

  private move(index: number, atMs: number): AudioBufferSize {
    this.lastStepAt = atMs;
    const size = BUFFER_SIZES[index] as AudioBufferSize;
    this.stepped(size);
    return size;
  }
}
