import { describe, expect, it } from 'vitest';
import { heldSessionLocks, holdSessionLock, isWebLocksAvailable, sessionLockName } from './locks';

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
