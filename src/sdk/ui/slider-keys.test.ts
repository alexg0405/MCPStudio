import { describe, expect, it } from 'vitest';
import { discreteSteps, FLOAT_STEPS, isSliderMoveKey, isSliderResetKey, sliderKeyTarget } from './slider-keys';

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe('sliderKeyTarget', () => {
  it('moves up and right by one step, down and left the other way', () => {
    expect(sliderKeyTarget(key('ArrowUp'), 0.5, FLOAT_STEPS)).toBeCloseTo(0.51);
    expect(sliderKeyTarget(key('ArrowRight'), 0.5, FLOAT_STEPS)).toBeCloseTo(0.51);
    expect(sliderKeyTarget(key('ArrowDown'), 0.5, FLOAT_STEPS)).toBeCloseTo(0.49);
    expect(sliderKeyTarget(key('ArrowLeft'), 0.5, FLOAT_STEPS)).toBeCloseTo(0.49);
  });

  it('Shift is a finer step and the Page keys a big one', () => {
    expect(sliderKeyTarget(key('ArrowUp', { shiftKey: true }), 0.5, FLOAT_STEPS)).toBeCloseTo(0.501);
    expect(sliderKeyTarget(key('PageUp'), 0.5, FLOAT_STEPS)).toBeCloseTo(0.6);
    expect(sliderKeyTarget(key('PageDown'), 0.5, FLOAT_STEPS)).toBeCloseTo(0.4);
  });

  it('Home and End go to the ends, and nothing leaves the 0-1 range', () => {
    expect(sliderKeyTarget(key('Home'), 0.5, FLOAT_STEPS)).toBe(0);
    expect(sliderKeyTarget(key('End'), 0.5, FLOAT_STEPS)).toBe(1);
    expect(sliderKeyTarget(key('ArrowUp'), 1, FLOAT_STEPS)).toBe(1);
    expect(sliderKeyTarget(key('PageDown'), 0.05, FLOAT_STEPS)).toBe(0);
  });

  it('leaves a key with Ctrl, Cmd or Alt held to the shortcuts', () => {
    expect(sliderKeyTarget(key('ArrowUp', { ctrlKey: true }), 0.5, FLOAT_STEPS)).toBeNull();
    expect(sliderKeyTarget(key('ArrowUp', { metaKey: true }), 0.5, FLOAT_STEPS)).toBeNull();
    expect(sliderKeyTarget(key('ArrowUp', { altKey: true }), 0.5, FLOAT_STEPS)).toBeNull();
    expect(sliderKeyTarget(key('a'), 0.5, FLOAT_STEPS)).toBeNull();
  });

  it('a control with a few positions moves one position per arrow', () => {
    const four = discreteSteps(4);
    expect(sliderKeyTarget(key('ArrowUp'), 0, four)).toBeCloseTo(1 / 3);
    expect(sliderKeyTarget(key('ArrowUp', { shiftKey: true }), 0, four)).toBeCloseTo(1 / 3);
  });

  it('knows its own keys', () => {
    expect(isSliderMoveKey('PageUp')).toBe(true);
    expect(isSliderMoveKey('Enter')).toBe(false);
    expect(isSliderResetKey('Delete')).toBe(true);
    expect(isSliderResetKey('Backspace')).toBe(true);
    expect(isSliderResetKey('a')).toBe(false);
  });
});
