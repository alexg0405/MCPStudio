import { describe, expect, it } from 'vitest';
import { resolveAccessChoice, scaleFactor } from './preferences';

describe('accessibility preferences', () => {
  it('on and off are the person\'s choice; auto asks the system', () => {
    expect(resolveAccessChoice('on', false)).toBe(true);
    expect(resolveAccessChoice('off', true)).toBe(false);
    expect(resolveAccessChoice('auto', true)).toBe(true);
    expect(resolveAccessChoice('auto', false)).toBe(false);
  });

  it('turns the interface size percentage into a factor, kept inside 90 to 150 percent', () => {
    expect(scaleFactor(100)).toBe(1);
    expect(scaleFactor(125)).toBe(1.25);
    expect(scaleFactor(10)).toBe(0.9);
    expect(scaleFactor(400)).toBe(1.5);
    expect(scaleFactor(Number.NaN)).toBe(1);
  });
});
