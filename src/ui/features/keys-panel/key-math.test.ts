import { describe, expect, it } from 'vitest';
import { FIXED_VELOCITY, isBlackKey, keyVelocity, padKey, padVelocity, pianoLayout } from './key-math';

describe('pianoLayout', () => {
  it('lays three octaves and the last C out across the width', () => {
    const keys = pianoLayout(48, 84);
    const whites = keys.filter((k) => !k.isBlack);
    const blacks = keys.filter((k) => k.isBlack);
    expect(whites).toHaveLength(22);
    expect(blacks).toHaveLength(15);
    expect(whites[0]!.left).toBe(0);
    expect(whites[21]!.left + whites[21]!.width).toBeCloseTo(1);
  });

  it('puts every black key between its two white neighbours, narrower than a white key', () => {
    const keys = pianoLayout(60, 72);
    const byKey = new Map(keys.map((k) => [k.key, k]));
    for (const black of keys.filter((k) => k.isBlack)) {
      const below = byKey.get(black.key - 1)!;
      const above = byKey.get(black.key + 1)!;
      expect(black.width).toBeLessThan(below.width);
      const centre = black.left + black.width / 2;
      expect(centre).toBeCloseTo(above.left);
    }
  });

  it('knows which keys are black', () => {
    expect([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map(isBlackKey)).toEqual([
      false, true, false, true, false, false, true, false, true, false, true, false,
    ]);
  });
});

describe('velocity', () => {
  it('plays louder lower on a piano key, and never silent', () => {
    expect(keyVelocity('position', 0)).toBeGreaterThan(0.2);
    expect(keyVelocity('position', 1)).toBe(1);
    expect(keyVelocity('position', 0.2)).toBeLessThan(keyVelocity('position', 0.8));
    expect(keyVelocity('position', -3)).toBe(keyVelocity('position', 0));
    expect(keyVelocity('position', 9)).toBe(1);
  });

  it('plays a pad loudest in the middle and softest at the corners', () => {
    expect(padVelocity('position', 0.5, 0.5)).toBeCloseTo(1);
    expect(padVelocity('position', 0, 0)).toBeCloseTo(0.4);
    expect(padVelocity('position', 0.5, 0.1)).toBeLessThan(padVelocity('position', 0.5, 0.4));
  });

  it('uses the fixed level when one is chosen, wherever the finger lands', () => {
    for (const setting of ['soft', 'medium', 'loud'] as const) {
      expect(keyVelocity(setting, 0.1)).toBe(FIXED_VELOCITY[setting]);
      expect(padVelocity(setting, 0, 0)).toBe(FIXED_VELOCITY[setting]);
    }
    expect(FIXED_VELOCITY.soft).toBeLessThan(FIXED_VELOCITY.medium);
    expect(FIXED_VELOCITY.medium).toBeLessThan(FIXED_VELOCITY.loud);
  });
});

describe('padKey', () => {
  it('numbers the pads from the bottom left, like a drum machine, over keys 36 to 51', () => {
    expect(padKey(0, 3)).toBe(36);
    expect(padKey(3, 3)).toBe(39);
    expect(padKey(0, 0)).toBe(48);
    expect(padKey(3, 0)).toBe(51);
    const all = new Set<number>();
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) all.add(padKey(column, row));
    expect(all.size).toBe(16);
  });
});
