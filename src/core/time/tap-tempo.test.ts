import { describe, expect, it } from 'vitest';
import { TapTempo } from './tap-tempo';

describe('tap tempo', () => {
  it('follows the taps, averaging the last four intervals', () => {
    const t = new TapTempo();
    expect(t.tap(0)).toBeNull();
    expect(t.tap(500)).toBeCloseTo(120);
    expect(t.tap(1000)).toBeCloseTo(120);
    // One late tap only nudges it.
    expect(t.tap(1600)).toBeCloseTo(112.5);
    expect(t.tap(2100)!).toBeCloseTo(114.3, 1);
  });

  it('starts over after a pause', () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(500);
    expect(t.tap(5000)).toBeNull();
    expect(t.tap(5750)).toBeCloseTo(80);
  });
});
