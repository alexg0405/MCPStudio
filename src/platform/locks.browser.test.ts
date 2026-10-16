import { describe, expect, it } from 'vitest';
import { createSharedHold, heldSessionLocks, holdSessionLock, isWebLocksAvailable, sessionLockName, withExclusiveLock } from './locks';

async function until(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!isWebLocksAvailable())('session locks', () => {
  it('holds a session lock until released', async () => {
    const id = `t${Math.random().toString(36).slice(2)}`;
    expect((await heldSessionLocks()).has(id)).toBe(false);
    const release = await holdSessionLock(id);
    expect((await heldSessionLocks()).has(id)).toBe(true);
    const { held = [] } = await navigator.locks.query();
    expect(held.some((l) => l.name === sessionLockName(id) && l.mode === 'exclusive')).toBe(true);
    release();
    release(); // idempotent
    await until(async () => !(await heldSessionLocks()).has(id));
    // It can be taken again.
    const again = await holdSessionLock(id);
    expect((await heldSessionLocks()).has(id)).toBe(true);
    again();
  });

  it('refuses a session lock that is already held', async () => {
    const id = `t${Math.random().toString(36).slice(2)}`;
    const release = await holdSessionLock(id);
    await expect(holdSessionLock(id)).rejects.toThrow('already open in another tab');
    release();
  });

  it('ignores locks that are not session locks', async () => {
    let releaseOther: () => void = () => {};
    const otherHeld = new Promise<void>((r) => (releaseOther = r));
    const pending = navigator.locks.request('something-else', () => otherHeld);
    const ids = await heldSessionLocks();
    expect([...ids].some((id) => id.includes('something-else'))).toBe(false);
    releaseOther();
    await pending;
  });
});

describe.skipIf(!isWebLocksAvailable())('exclusive runs and shared holds (clean-up of unused audio)', () => {
  const name = () => `t-lock-${Math.random().toString(36).slice(2)}`;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs a function exclusively, and with ifAvailable gives up when the lock is taken', async () => {
    const lock = name();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const inside = new Promise<void>((resolve) => void withExclusiveLock(lock, async () => (resolve(), held)));
    await inside;
    expect(await withExclusiveLock(lock, async () => 1, { ifAvailable: true })).toEqual({ ran: false });
    release();
    expect(await withExclusiveLock(lock, async () => 2)).toEqual({ ran: true, value: 2 });
  });

  it('a shared hold keeps an exclusive run waiting until the last holder is done', async () => {
    const lock = name();
    const hold = createSharedHold(lock);
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = hold(async () => {
      order.push('first in');
      await gate;
      order.push('first out');
    });
    await pause(20);
    const exclusive = withExclusiveLock(lock, async () => void order.push('exclusive'));
    await pause(20);
    // Joins the hold that is already there even though an exclusive request is waiting (no deadlock).
    const second = hold(async () => void order.push('second'));
    await second;
    expect(order).toEqual(['first in', 'second']);
    release();
    await first;
    await exclusive;
    expect(order).toEqual(['first in', 'second', 'first out', 'exclusive']);
  });

  it('takes the lock again after everyone let go, and passes errors on', async () => {
    const lock = name();
    const hold = createSharedHold(lock);
    await expect(hold(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // The browser frees the lock a moment after the holder's promise settles: an exclusive request simply waits for it.
    expect(await withExclusiveLock(lock, async () => 'free')).toEqual({ ran: true, value: 'free' });
    expect(await hold(async () => 7)).toBe(7);
  });
});
