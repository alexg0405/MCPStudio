import { describe, expect, it } from 'vitest';
import { resolveTouchLayout } from './layout';

describe('resolveTouchLayout', () => {
  it('follows the device on Auto: a coarse main pointer (a tablet) turns it on, a trackpad does not', () => {
    expect(resolveTouchLayout('auto', true)).toBe(true);
    expect(resolveTouchLayout('auto', false)).toBe(false);
  });

  it('obeys On and Off whatever the device says', () => {
    expect(resolveTouchLayout('on', false)).toBe(true);
    expect(resolveTouchLayout('off', true)).toBe(false);
  });
});
