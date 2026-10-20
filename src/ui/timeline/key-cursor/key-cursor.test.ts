import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyEventLike } from '@core/commands/keymap';
import { Viewport } from '../viewport';
import { CoalescedAnnouncer } from './announcer';
import { lengthText, plural, positionText, spokenKeyName, velocityNumber } from './describe';
import { barTick, revealRow, revealTicks, snapCursorTick, stepTick } from './grid-math';
import { decodeKey, type KeyIntent } from './keys';

const FOUR_FOUR = { num: 4, den: 4 };
const BAR = 3840;

describe('positionText', () => {
  it('counts bars and beats from 1', () => {
    expect(positionText(0, FOUR_FOUR)).toBe('bar 1 beat 1');
    expect(positionText(960 * 2, FOUR_FOUR)).toBe('bar 1 beat 3');
    expect(positionText(BAR + 960 * 2, FOUR_FOUR)).toBe('bar 2 beat 3');
  });

  it('says what is between beats in steps, then in ticks', () => {
    expect(positionText(240, FOUR_FOUR)).toBe('bar 1 beat 1 plus 1 step');
    expect(positionText(480, FOUR_FOUR)).toBe('bar 1 beat 1 plus 2 steps');
    expect(positionText(BAR + 960 + 40, FOUR_FOUR)).toBe('bar 2 beat 2 plus 40 ticks');
  });

  it('follows the time signature', () => {
    // 6/8: a beat is an eighth note (480 ticks), a bar is 2880.
    expect(positionText(2880 + 480, { num: 6, den: 8 })).toBe('bar 2 beat 2');
  });
});

describe('lengthText', () => {
  it('names bars, note values, steps and ticks', () => {
    expect(lengthText(BAR, FOUR_FOUR)).toBe('1 bar');
    expect(lengthText(BAR * 2, FOUR_FOUR)).toBe('2 bars');
    expect(lengthText(960, FOUR_FOUR)).toBe('1/4');
    expect(lengthText(240, FOUR_FOUR)).toBe('1/16');
    expect(lengthText(720, FOUR_FOUR)).toBe('3/16');
    expect(lengthText(1920, FOUR_FOUR)).toBe('1/2');
    expect(lengthText(320, FOUR_FOUR)).toBe('320 ticks');
  });
});

describe('spoken names and numbers', () => {
  it('spells sharps out and uses the app octave numbering (middle C is C5)', () => {
    expect(spokenKeyName(60)).toBe('C5');
    expect(spokenKeyName(61)).toBe('C sharp 5');
    expect(spokenKeyName(0)).toBe('C0');
  });

  it('shows velocity as the MIDI number', () => {
    expect(velocityNumber(100 / 128)).toBe(100);
    expect(velocityNumber(1)).toBe(127);
    expect(velocityNumber(0)).toBe(1);
  });

  it('pluralises', () => {
    expect(plural(1, 'note')).toBe('1 note');
    expect(plural(3, 'note')).toBe('3 notes');
  });
});

describe('stepping along the grid', () => {
  it('moves to the next and previous grid line', () => {
    expect(stepTick(0, 1, 240, 10_000)).toBe(240);
    expect(stepTick(240, 1, 240, 10_000)).toBe(480);
    expect(stepTick(240, -1, 240, 10_000)).toBe(0);
    expect(stepTick(0, -1, 240, 10_000)).toBe(0);
  });

  it('puts an off-grid tick on the line in the direction of travel', () => {
    expect(stepTick(100, 1, 240, 10_000)).toBe(240);
    expect(stepTick(100, -1, 240, 10_000)).toBe(0);
    expect(stepTick(340, -1, 240, 10_000)).toBe(240);
  });

  it('moves by single ticks when the grid is off, and stops at the end', () => {
    expect(stepTick(10, 1, 1, 10_000)).toBe(11);
    expect(stepTick(9_900, 1, 240, 10_000)).toBe(10_000);
    expect(stepTick(10_000, 1, 240, 10_000)).toBe(10_000);
  });

  it('jumps by bars', () => {
    expect(barTick(0, 1, BAR, 100_000)).toBe(BAR);
    expect(barTick(BAR + 480, -1, BAR, 100_000)).toBe(BAR);
    expect(barTick(BAR, -1, BAR, 100_000)).toBe(0);
  });

  it('snaps a cursor back onto a changed grid', () => {
    expect(snapCursorTick(500, 240, 10_000)).toBe(480);
    expect(snapCursorTick(-5, 240, 10_000)).toBe(0);
  });
});

describe('revealing the cursor with one jump', () => {
  function view(): Viewport {
    const vp = new Viewport(100);
    vp.width = 800;
    vp.height = 200;
    vp.pxPerTick = 0.1;
    vp.rowHeight = 20;
    return vp;
  }

  it('leaves a cursor that is on screen alone', () => {
    const vp = view();
    expect(revealTicks(vp, 1000, 1240, 100_000)).toBe(false);
    expect(vp.scrollTick).toBe(0);
  });

  it('scrolls right so a cursor past the edge shows, in one step', () => {
    const vp = view();
    expect(revealTicks(vp, 9000, 9240, 100_000)).toBe(true);
    expect(vp.tickToX(9240)).toBeLessThanOrEqual(vp.width);
    expect(vp.tickToX(9000)).toBeGreaterThanOrEqual(0);
  });

  it('scrolls left to a cursor behind the view', () => {
    const vp = view();
    vp.scrollTick = 5000;
    expect(revealTicks(vp, 100, 340, 100_000)).toBe(true);
    expect(vp.tickToX(100)).toBeGreaterThanOrEqual(0);
  });

  it('scrolls to a row below and above the view', () => {
    const vp = view();
    expect(revealRow(vp, 40)).toBe(true);
    expect(vp.rowToY(40) + vp.rowHeight).toBeLessThanOrEqual(vp.height);
    expect(revealRow(vp, 2)).toBe(true);
    expect(vp.rowToY(2)).toBeGreaterThanOrEqual(0);
    expect(revealRow(vp, 3)).toBe(false);
  });
});

function key(init: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { code: init.key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init };
}

describe('decodeKey', () => {
  const intent = (init: Partial<KeyEventLike> & { key: string }): KeyIntent | null => decodeKey(key(init));

  it('moves with the arrows, by a jump with Ctrl or Cmd, and extends with Shift', () => {
    expect(intent({ key: 'ArrowLeft' })).toEqual({ kind: 'move', columns: -1, rows: 0, isJump: false, isExtend: false });
    expect(intent({ key: 'ArrowDown' })).toEqual({ kind: 'move', columns: 0, rows: 1, isJump: false, isExtend: false });
    expect(intent({ key: 'ArrowRight', ctrlKey: true })).toMatchObject({ isJump: true, columns: 1 });
    expect(intent({ key: 'ArrowRight', metaKey: true })).toMatchObject({ isJump: true, columns: 1 });
    expect(intent({ key: 'ArrowUp', shiftKey: true })).toMatchObject({ isExtend: true, rows: -1 });
    expect(intent({ key: 'ArrowUp', shiftKey: true, ctrlKey: true })).toMatchObject({ isExtend: true, isJump: true });
  });

  it('pages and goes to the ends', () => {
    expect(intent({ key: 'PageUp' })).toEqual({ kind: 'page', direction: -1, isExtend: false });
    expect(intent({ key: 'PageDown', shiftKey: true })).toEqual({ kind: 'page', direction: 1, isExtend: true });
    expect(intent({ key: 'Home' })).toEqual({ kind: 'edge', edge: 'start', isExtend: false });
    expect(intent({ key: 'End' })).toEqual({ kind: 'edge', edge: 'end', isExtend: false });
  });

  it('selects, inserts, deletes and clears', () => {
    expect(intent({ key: 'Enter' })).toEqual({ kind: 'toggle' });
    expect(intent({ key: 'Enter', shiftKey: true })).toEqual({ kind: 'insert' });
    expect(intent({ key: 'Insert' })).toEqual({ kind: 'insert' });
    expect(intent({ key: 'Delete' })).toEqual({ kind: 'delete' });
    expect(intent({ key: 'Backspace' })).toEqual({ kind: 'delete' });
    expect(intent({ key: 'Escape' })).toEqual({ kind: 'clear' });
    expect(decodeKey(key({ key: 'a', code: 'KeyA', ctrlKey: true }))).toEqual({ kind: 'selectAll' });
    expect(decodeKey(key({ key: 'a', code: 'KeyA', metaKey: true }))).toEqual({ kind: 'selectAll' });
  });

  it('moves, resizes and adjusts the selection with Alt', () => {
    expect(intent({ key: 'ArrowRight', altKey: true })).toEqual({ kind: 'shift', columns: 1, rows: 0, isJump: false });
    expect(intent({ key: 'ArrowUp', altKey: true })).toEqual({ kind: 'shift', columns: 0, rows: -1, isJump: false });
    expect(intent({ key: 'PageUp', altKey: true })).toEqual({ kind: 'shift', columns: 0, rows: -1, isJump: true });
    expect(intent({ key: 'ArrowRight', altKey: true, shiftKey: true })).toEqual({ kind: 'resize', direction: 1 });
    expect(intent({ key: 'ArrowLeft', altKey: true, shiftKey: true })).toEqual({ kind: 'resize', direction: -1 });
    expect(intent({ key: 'ArrowUp', altKey: true, shiftKey: true })).toEqual({ kind: 'adjust', direction: 1 });
    expect(intent({ key: 'ArrowDown', altKey: true, shiftKey: true })).toEqual({ kind: 'adjust', direction: -1 });
  });

  it('reads letters by the physical key, so Option on a Mac does not change the meaning', () => {
    expect(decodeKey(key({ key: 'å', code: 'KeyA', altKey: true }))).toBeNull();
    expect(decodeKey(key({ key: '?', code: 'Slash', shiftKey: true }))).toEqual({ kind: 'describe' });
  });

  it('leaves Space, letters, tool keys and other shortcuts to the app', () => {
    expect(intent({ key: ' ', code: 'Space' })).toBeNull();
    expect(decodeKey(key({ key: 'p', code: 'KeyP' }))).toBeNull();
    expect(decodeKey(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBeNull();
    expect(decodeKey(key({ key: 'z', code: 'KeyZ', metaKey: true }))).toBeNull();
    expect(intent({ key: 'Tab' })).toBeNull();
    expect(intent({ key: '1', code: 'Digit1', altKey: true })).toBeNull();
  });
});

describe('CoalescedAnnouncer', () => {
  let spoken: string[];
  let clock: number;
  let announcer: CoalescedAnnouncer;

  beforeEach(() => {
    vi.useFakeTimers();
    spoken = [];
    clock = 1000;
    announcer = new CoalescedAnnouncer((text) => spoken.push(text), 120, () => clock);
  });

  afterEach(() => vi.useRealTimers());

  function advance(ms: number): void {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }

  it('says the first message at once', () => {
    announcer.say('first');
    expect(spoken).toEqual(['first']);
  });

  it('keeps only the newest of a burst and says it when the slot opens', () => {
    announcer.say('one');
    for (const text of ['two', 'three', 'four']) {
      advance(10);
      announcer.say(text);
    }
    expect(spoken).toEqual(['one']);
    advance(200);
    expect(spoken).toEqual(['one', 'four']);
  });

  it('says one message per interval during a long burst', () => {
    announcer.say('0');
    for (let i = 1; i <= 30; i++) {
      advance(33);
      announcer.say(String(i));
    }
    advance(200);
    // 30 messages in about a second: far fewer are spoken, the last of them included.
    expect(spoken.length).toBeLessThan(12);
    expect(spoken[spoken.length - 1]).toBe('30');
  });

  it('answers a direct question at once and drops what was waiting', () => {
    announcer.say('a');
    announcer.say('b');
    announcer.sayNow('answer');
    advance(500);
    expect(spoken).toEqual(['a', 'answer']);
  });
});
