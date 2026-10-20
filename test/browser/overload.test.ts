/**
 * The overload guard for real-time tests (`test/helpers/overload.ts`): a failure on a quiet machine is a failure, a failure
 * on an overloaded one is repeated and, when every attempt was overloaded, skipped. The machine's load is replaced by a fake
 * watch here, so these tests say the same on any machine.
 */
import { describe, expect, it } from 'vitest';
import { controlRenderSpeed, LoadWatch, retryWhenOverloaded, type LoadReport } from '../helpers/overload';

const QUIET: LoadReport = { worstTimerLagMs: 2, controlSpeed: 200, overloaded: false };
const BUSY: LoadReport = { worstTimerLagMs: 900, controlSpeed: 4, overloaded: true };

/** A fake watch that reports `report` and counts how often it was discarded or stopped. */
function fakeWatch(report: LoadReport) {
  const seen = { stopped: 0, discarded: 0 };
  return {
    seen,
    watchLoad: () => ({
      stop: async () => {
        seen.stopped++;
        return report;
      },
      discard: () => void seen.discarded++,
    }),
  };
}

/** A stand-in for the test context whose `skip` records the note and ends the test the way Vitest's does. */
function fakeTest() {
  const skipped: string[] = [];
  return {
    skipped,
    skip: ((note?: string) => {
      skipped.push(note ?? '');
      throw new Error('skipped');
    }) as never,
  };
}

describe('retryWhenOverloaded', () => {
  it('a measurement that passes runs once and needs no report', async () => {
    const quiet = fakeWatch(QUIET);
    let runs = 0;
    await retryWhenOverloaded(fakeTest(), async () => void runs++, { watchLoad: quiet.watchLoad, pauseMs: 0 });
    expect(runs).toBe(1);
    expect(quiet.seen).toEqual({ stopped: 0, discarded: 1 });
  });

  it('a failure on a quiet machine is thrown at once, unchanged', async () => {
    const quiet = fakeWatch(QUIET);
    let runs = 0;
    const failing = async () => {
      runs++;
      throw new Error('the clock fell behind');
    };
    await expect(retryWhenOverloaded(fakeTest(), failing, { watchLoad: quiet.watchLoad, pauseMs: 0 })).rejects.toThrow(
      'the clock fell behind',
    );
    expect(runs).toBe(1);
  });

  it('a failure on an overloaded machine is run again, and passes when the next attempt does', async () => {
    const busy = fakeWatch(BUSY);
    let runs = 0;
    await retryWhenOverloaded(
      fakeTest(),
      async () => {
        runs++;
        if (runs < 3) throw new Error('too slow');
      },
      { watchLoad: busy.watchLoad, pauseMs: 0 },
    );
    expect(runs).toBe(3);
  });

  it('skips with the numbers when every attempt failed on an overloaded machine', async () => {
    const busy = fakeWatch(BUSY);
    const test = fakeTest();
    let runs = 0;
    const failing = async () => {
      runs++;
      throw new Error('too slow');
    };
    await expect(retryWhenOverloaded(test, failing, { watchLoad: busy.watchLoad, pauseMs: 0, attempts: 2 })).rejects.toThrow(
      'skipped',
    );
    expect(runs).toBe(2);
    expect(test.skipped).toHaveLength(1);
    expect(test.skipped[0]).toContain('overloaded in all 2 attempts');
    expect(test.skipped[0]).toContain('too slow');
  });
});

describe('the load watch', () => {
  it('reads a control render that is far faster than real time, and a timer that fires on time, on a machine doing nothing else', async () => {
    const speeds = [await controlRenderSpeed(), await controlRenderSpeed(), await controlRenderSpeed()];
    // Only the best counts: another process may take one of the three.
    expect(Math.max(...speeds)).toBeGreaterThan(5);
    const watch = LoadWatch.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const report = await watch.stop();
    expect(report.controlSpeed).toBeGreaterThan(0);
    expect(report.worstTimerLagMs).toBeGreaterThanOrEqual(0);
  });
});
