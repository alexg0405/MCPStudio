import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { swingAmount, swingDelay, swingTick } from './swing';

describe('swing curve', () => {
  it('moves the odd 1/16 by swing × half a step and bends everything around it', () => {
    // At full swing (s = 120 ticks): the 1/32 before the odd 1/16, the odd 1/16, the 1/32 after.
    expect(swingTick(120, 1)).toBe(180);
    expect(swingTick(240, 1)).toBe(360);
    expect(swingTick(360, 1)).toBe(420);
    // The 8th lines stay where they are.
    expect(swingTick(0, 1)).toBe(0);
    expect(swingTick(480, 1)).toBe(480);
    expect(swingTick(3840 + 240, 0.5)).toBe(3840 + 300);
  });

  it('delays a note exactly on an odd 1/16 by exactly what the old swing did', () => {
    for (const swing of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.45, 0.5, 0.7, 1])
      for (const tick of [240, 720, 1200, 3840 + 1680])
        expect(swingDelay(tick, swing)).toBe(swing * (240 / 2));
  });

  it('does nothing without swing', () => {
    expect(swingDelay(250, 0)).toBe(0);
    expect(swingTick(250, 0)).toBe(250);
    expect(swingAmount(-1)).toBe(0);
    expect(swingAmount(3)).toBe(120);
  });

  it('keeps humanized notes and rolls in the groove: in order, never early, at most s late', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 7680 }), fc.integer({ min: 1, max: 480 }), (swing, a, gap) => {
        const b = a + gap;
        const s = swingAmount(swing);
        const da = swingDelay(a, swing);
        expect(da).toBeGreaterThanOrEqual(0);
        expect(da).toBeLessThanOrEqual(s + 1e-9);
        // Monotonic: notes never swap places, and touching notes still touch.
        expect(swingTick(b, swing)).toBeGreaterThan(swingTick(a, swing) - 1e-9);
      }),
    );
  });

  it('a humanized note next to an odd 1/16 keeps most of the swing', () => {
    // 3 ticks late at swing 0.5 (s = 60): it lands 0.75 × 3 ticks after the swung grid line.
    expect(swingTick(243, 0.5)).toBeCloseTo(300 + 0.75 * 3, 9);
    expect(swingTick(237, 0.5)).toBeCloseTo(300 - 1.25 * 3, 9);
  });
});
