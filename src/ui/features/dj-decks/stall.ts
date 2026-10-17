/**
 * When a deck's "Loading…" note shows: only once its stall has lasted a moment, so a stall too short to matter (a
 * few frames while the next part arrives) doesn't flash. It hides at once when the deck is no longer stalled.
 */
export const STALL_SHOW_MS = 150;

export class StallLatch {
  /** When the current stall began (NaN: not stalled). */
  private since = NaN;
  private shown = false;

  constructor(private readonly delayMs = STALL_SHOW_MS) {}

  /** Feeds the stalled flag with the frame's time (ms); returns whether the note should show now. */
  update(stalled: boolean, now: number): boolean {
    if (!stalled) {
      this.since = NaN;
      this.shown = false;
      return false;
    }
    if (Number.isNaN(this.since)) this.since = now;
    if (!this.shown && now - this.since >= this.delayMs) this.shown = true;
    return this.shown;
  }
}
