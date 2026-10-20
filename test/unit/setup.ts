/**
 * Runs before every Node test file (vite.config.ts, projects `unit` and `unit-timing`).
 *
 * `vi.waitFor` gives up after one second unless told otherwise. That is plenty for a quiet machine and not for one where
 * several workers (or other programs) share the cores: a test that waits for a store to change, a toast, a stream to open
 * then failed with a timeout that said nothing about the code. A wait that succeeds costs the same whatever its limit, so the
 * default is 15 s and a test that wants another limit still passes its own.
 */
import { vi } from 'vitest';

/** How long a `vi.waitFor` waits when the test gives no limit (ms). */
const DEFAULT_WAIT_FOR_MS = 15_000;
/** How often it looks (ms): a little quicker than Vitest's 50. */
const WAIT_FOR_INTERVAL_MS = 25;

const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback: Parameters<typeof waitFor>[0], options?: number | { timeout?: number; interval?: number }) => {
  if (typeof options === 'number') return waitFor(callback, options);
  return waitFor(callback, { timeout: DEFAULT_WAIT_FOR_MS, interval: WAIT_FOR_INTERVAL_MS, ...options });
}) as typeof vi.waitFor;
