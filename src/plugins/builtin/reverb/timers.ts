/** A set of one-shot timers that can all be cancelled together (an effect's fade-outs and clean-ups). */
export interface Timers {
  /** Runs `action` after `delayMs` milliseconds, unless `clear` comes first. */
  later(delayMs: number, action: () => void): void;
  /** Cancels every timer that has not fired yet. */
  clear(): void;
}

export function createTimers(): Timers {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  return {
    later(delayMs, action) {
      const timer = setTimeout(() => {
        pending.delete(timer);
        action();
      }, delayMs);
      pending.add(timer);
    },
    clear() {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    },
  };
}
