import { describe, expect, it } from 'vitest';
import { StallLatch, STALL_SHOW_MS } from './stall';

describe('StallLatch (the "Loading…" note of a stalled deck)', () => {
  it('shows only after the stall has lasted the delay, not at its first frame', () => {
    const l = new StallLatch();
    expect(l.update(true, 1000)).toBe(false);
    expect(l.update(true, 1000 + STALL_SHOW_MS - 1)).toBe(false);
    expect(l.update(true, 1000 + STALL_SHOW_MS)).toBe(true);
    expect(l.update(true, 2000)).toBe(true);
  });

  it('a stall shorter than the delay never shows', () => {
    const l = new StallLatch();
    expect(l.update(true, 0)).toBe(false);
    expect(l.update(true, 80)).toBe(false);
    expect(l.update(false, 100)).toBe(false);
    expect(l.update(true, 200)).toBe(false);
    expect(l.update(true, 200 + STALL_SHOW_MS - 1)).toBe(false);
  });

  it('hides at once when the stall clears, and the next stall waits the delay again', () => {
    const l = new StallLatch();
    l.update(true, 0);
    expect(l.update(true, STALL_SHOW_MS)).toBe(true);
    expect(l.update(false, STALL_SHOW_MS + 16)).toBe(false);
    expect(l.update(true, 500)).toBe(false);
    expect(l.update(true, 500 + STALL_SHOW_MS)).toBe(true);
  });

  it('a custom delay is respected', () => {
    const l = new StallLatch(40);
    l.update(true, 10);
    expect(l.update(true, 49)).toBe(false);
    expect(l.update(true, 50)).toBe(true);
  });
});
