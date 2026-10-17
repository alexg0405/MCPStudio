import { describe, expect, it } from 'vitest';
import { blockRange, planWindow, poolSlots } from './deck-window';

describe('planWindow', () => {
  const base = { blocks: 5000, behind: 22, ahead: 66, capacity: 150 };

  it('loads what is about to be heard first, then the pins, then the window ahead, then behind', () => {
    const plan = planWindow({ ...base, playBlock: 1000, pins: [{ first: 4000, last: 4002 }, { first: 10, last: 11 }] });
    expect(plan.slice(0, 4)).toEqual([1000, 1001, 1002, 1003]);
    expect(plan[4]).toBe(999);
    // Pins next, the nearer one (10 is 990 away, 4000 is 3000 away) first.
    expect(plan.slice(5, 10)).toEqual([11, 10, 4000, 4001, 4002]);
    // Then ahead in order and behind in order.
    expect(plan.slice(10, 13)).toEqual([1004, 1005, 1006]);
    const behindStart = plan.indexOf(998);
    expect(behindStart).toBeGreaterThan(plan.indexOf(1066));
    expect(plan[behindStart + 1]).toBe(997);
    expect(plan.length).toBe(4 + 1 + 5 + (66 - 3) + (22 - 1));
    expect(new Set(plan).size).toBe(plan.length);
  });

  it('keeps inside the song at both ends', () => {
    const start = planWindow({ ...base, playBlock: 0 });
    expect(Math.min(...start)).toBe(0);
    expect(start.length).toBe(67);
    const end = planWindow({ ...base, playBlock: 4999 });
    expect(Math.max(...end)).toBe(4999);
    expect(end.length).toBe(1 + 22);
    // A song that fits is wanted whole.
    const small = planWindow({ blocks: 30, playBlock: 12, behind: 22, ahead: 66, capacity: 150 });
    expect([...small].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('never wants more than the pool holds: the far window goes before a pin does', () => {
    const plan = planWindow({ blocks: 5000, playBlock: 2000, behind: 22, ahead: 66, capacity: 30, pins: [{ first: 100, last: 101 }, { first: 4500, last: 4501 }] });
    expect(plan.length).toBe(30);
    expect(plan).toContain(100);
    expect(plan).toContain(4501);
    expect(plan).toContain(2003);
    expect(plan).not.toContain(2066);
    expect(plan).not.toContain(1990);
    expect(planWindow({ blocks: 5000, playBlock: 2000, behind: 22, ahead: 66, capacity: 3 })).toEqual([2000, 2001, 2002]);
  });

  it('heads the other way when the song is heard backward', () => {
    const plan = planWindow({ ...base, playBlock: 2000, direction: -1 });
    expect(plan.slice(0, 4)).toEqual([2000, 1999, 1998, 1997]);
    expect(plan[4]).toBe(2001);
    expect(plan).toContain(2000 - 66);
    expect(plan).not.toContain(2000 + 23);
  });

  it('turns frames into block ranges and a window into pool slots', () => {
    expect(blockRange(0, 65536, 65536, 10)).toEqual({ first: 0, last: 0 });
    expect(blockRange(65535, 65537, 65536, 10)).toEqual({ first: 0, last: 1 });
    expect(blockRange(70000, 70000, 65536, 10)).toBeNull();
    expect(blockRange(600_000, 7_000_000, 65536, 10)).toEqual({ first: 9, last: 9 });
    const p = poolSlots({ sampleRate: 48000, blockFrames: 65536, behindSec: 30, aheadSec: 90, pinSlots: 57 });
    expect(p.behind).toBe(23);
    expect(p.ahead).toBe(67);
    // 150 blocks of 2 × 4 bytes × 65536 frames: 79 MB.
    expect((p.slots * 65536 * 8) / 1e6).toBeLessThan(85);
  });
});
