/**
 * Waiting in UI tests: for the state a gesture leads to, not for a number of frames or milliseconds.
 *
 * Two frames after a tap is plenty on a quiet machine and not enough on one that is rendering audio for other tests. A test
 * that waits for a condition passes as soon as it holds and, if it never does, fails with the value it last saw. A test of
 * something that must NOT happen (a menu that stays closed, no React commit while idle) cannot wait for a condition; it
 * waits for the page to be still first (`untilStill`) and then watches for the stated time.
 */

/** Options for `expect.poll(…, EVENTUALLY)`: up to 15 s for the state to arrive, checked every 25 ms. */
export const EVENTUALLY = { timeout: 15_000, interval: 25 } as const;

/** How long a counter must stay unchanged to count as still (ms): longer than the 300 ms some views take to save themselves. */
const STILL_FOR_MS = 400;
/** How long `untilStill` waits at most before it gives up and lets the test judge what it sees (ms). */
const STILL_GIVE_UP_MS = 15_000;
const POLL_MS = 25;

/**
 * Waits until `value()` has stayed the same for 400 ms (or 15 s have passed). For a test that counts something after a
 * change (React commits, DOM writes, redraws) and must not count the change's own late effects.
 */
export async function untilStill(value: () => unknown): Promise<void> {
  const giveUp = performance.now() + STILL_GIVE_UP_MS;
  let seen = value();
  let since = performance.now();
  while (performance.now() < giveUp && performance.now() - since < STILL_FOR_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const now = value();
    if (!Object.is(now, seen)) {
      seen = now;
      since = performance.now();
    }
  }
}
