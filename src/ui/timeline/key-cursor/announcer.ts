/**
 * Speaks what a keyboard cursor passes over, without flooding. A held arrow key repeats about thirty times a second;
 * a screen reader queues every message, so it would keep talking long after the key was let go. This says the first
 * message at once, then at most one more every `intervalMs`, and always the latest (earlier ones are dropped).
 */
import { announce } from '../../a11y/announce';

/** At most one spoken message per this many milliseconds while keys repeat. */
export const ANNOUNCE_INTERVAL_MS = 120;

/** Where the words go (the live region by default; a test or another surface can plug in its own). */
export type Speak = (text: string) => void;

/** Says messages through a live region, one every `intervalMs` at most, the newest first when several wait. */
export class CoalescedAnnouncer {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSpokeAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly speak: Speak = (text) => announce(text),
    private readonly intervalMs = ANNOUNCE_INTERVAL_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Says `text` now when the last message is old enough, else keeps it (replacing any kept one) for the next slot. */
  say(text: string): void {
    const waited = this.now() - this.lastSpokeAt;
    if (waited >= this.intervalMs && this.timer === null) {
      this.deliver(text);
      return;
    }
    this.pending = text;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), Math.max(0, this.intervalMs - waited));
  }

  /** Says `text` immediately and forgets any message that was waiting (the answer to a direct question). */
  sayNow(text: string): void {
    this.cancel();
    this.deliver(text);
  }

  /** Drops the waiting message and its timer (the editor closed). */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private flush(): void {
    this.timer = null;
    const text = this.pending;
    this.pending = null;
    if (text !== null) this.deliver(text);
  }

  private deliver(text: string): void {
    this.lastSpokeAt = this.now();
    this.speak(text);
  }
}
