import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, TouchRecognizer, type GestureSink, type TwoFingerFrame } from './recognizer';

/** A recognizer with a log of what it reported. */
function setup(tuning = DEFAULT_TUNING) {
  const log: string[] = [];
  const frames: TwoFingerFrame[] = [];
  const sink: GestureSink = {
    onMultiTouchStart: () => log.push('multi'),
    onTwoFinger: (f) => {
      // The frame is reused: copy what the test checks.
      frames.push({ ...f });
    },
    onTwoFingerEnd: () => log.push('twoEnd'),
    onLongPress: (x, y) => log.push(`long ${x},${y}`),
    onDoubleTap: (x, y) => log.push(`double ${x},${y}`),
  };
  return { rec: new TouchRecognizer(sink, tuning), log, frames };
}

describe('TouchRecognizer: one finger', () => {
  it('hands a single finger to the tool', () => {
    const { rec, log } = setup();
    expect(rec.pointerDown(1, 100, 100, 0)).toBe('pass');
    expect(rec.pointerMove(1, 140, 120, 16)).toBe('pass');
    expect(rec.pointerUp(1, 140, 120, 32)).toBe('pass');
    expect(log).toEqual([]);
  });

  it('turns a finger that rests into a long press at 500 ms', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 100, 100, 0);
    expect(rec.nextDeadline()).toBe(500);
    rec.tick(499);
    expect(log).toEqual([]);
    rec.tick(500);
    expect(log).toEqual(['long 100,100']);
    // The lift of a long press belongs to the menu, not to the tool; nothing fires twice.
    expect(rec.pointerMove(1, 101, 101, 520)).toBe('swallow');
    rec.tick(900);
    expect(rec.pointerUp(1, 101, 101, 1000)).toBe('swallow');
    expect(log).toEqual(['long 100,100']);
    expect(rec.nextDeadline()).toBeNull();
  });

  it('allows a small tremor but not a drag during the press', () => {
    const tremor = setup();
    tremor.rec.pointerDown(1, 100, 100, 0);
    tremor.rec.pointerMove(1, 106, 104, 100);
    expect(tremor.rec.nextDeadline()).toBe(500);
    tremor.rec.tick(500);
    expect(tremor.log).toEqual(['long 106,104']);

    const drag = setup();
    drag.rec.pointerDown(1, 100, 100, 0);
    drag.rec.pointerMove(1, 100 + DEFAULT_TUNING.longPressSlopPx + 1, 100, 100);
    expect(drag.rec.nextDeadline()).toBeNull();
    drag.rec.tick(800);
    expect(drag.log).toEqual([]);
  });

  it('does not come back to a press after the finger has left the slop and returned', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerMove(1, 150, 100, 50);
    rec.pointerMove(1, 100, 100, 100);
    rec.tick(700);
    expect(log).toEqual([]);
  });

  it('fires the long press from a move that arrives after the deadline', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 10, 10, 0);
    expect(rec.pointerMove(1, 11, 10, 650)).toBe('swallow');
    expect(log).toEqual(['long 11,10']);
  });
});

describe('TouchRecognizer: double tap', () => {
  it('reports a second quick tap near the first', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 50, 50, 0);
    rec.pointerUp(1, 50, 50, 80);
    rec.pointerDown(2, 60, 55, 200);
    rec.pointerUp(2, 60, 55, 270);
    expect(log).toEqual(['double 60,55']);
  });

  it('needs the second tap soon enough and close enough', () => {
    const slow = setup();
    slow.rec.pointerDown(1, 50, 50, 0);
    slow.rec.pointerUp(1, 50, 50, 80);
    slow.rec.pointerDown(2, 50, 50, 80 + DEFAULT_TUNING.doubleTapMs + 1);
    slow.rec.pointerUp(2, 50, 50, 80 + DEFAULT_TUNING.doubleTapMs + 60);
    expect(slow.log).toEqual([]);

    const far = setup();
    far.rec.pointerDown(1, 50, 50, 0);
    far.rec.pointerUp(1, 50, 50, 80);
    far.rec.pointerDown(2, 50 + DEFAULT_TUNING.doubleTapSlopPx + 5, 50, 150);
    far.rec.pointerUp(2, 50 + DEFAULT_TUNING.doubleTapSlopPx + 5, 50, 200);
    expect(far.log).toEqual([]);
  });

  it('does not count a drag, a long touch or a long press as a tap', () => {
    const { rec, log } = setup();
    // A drag then a tap.
    rec.pointerDown(1, 50, 50, 0);
    rec.pointerMove(1, 90, 50, 30);
    rec.pointerUp(1, 90, 50, 60);
    rec.pointerDown(2, 90, 50, 150);
    rec.pointerUp(2, 90, 50, 200);
    // A touch held too long (but still), then a tap.
    rec.pointerDown(3, 90, 50, 400);
    rec.pointerUp(3, 90, 50, 400 + DEFAULT_TUNING.tapMaxMs + 10);
    rec.pointerDown(4, 90, 50, 900);
    rec.pointerUp(4, 90, 50, 960);
    expect(log).toEqual([]);
  });

  it('a double tap needs a new pair: the third tap is the first of the next', () => {
    const { rec, log } = setup();
    for (const t of [0, 150, 300]) {
      rec.pointerDown(1, 20, 20, t);
      rec.pointerUp(1, 20, 20, t + 40);
    }
    expect(log).toEqual(['double 20,20']);
  });

  it('a cancelled touch is not a tap', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 20, 20, 0);
    expect(rec.pointerCancel(1)).toBe('pass');
    rec.pointerDown(2, 20, 20, 100);
    rec.pointerUp(2, 20, 20, 140);
    expect(log).toEqual([]);
  });
});

describe('TouchRecognizer: two fingers', () => {
  it('drops the tool\'s drag when the second finger lands and swallows what follows', () => {
    const { rec, log } = setup();
    expect(rec.pointerDown(1, 100, 100, 0)).toBe('pass');
    expect(rec.pointerDown(2, 200, 100, 30)).toBe('swallow');
    expect(log).toEqual(['multi']);
    expect(rec.isTwoFinger).toBe(true);
    expect(rec.pointerMove(1, 110, 100, 50)).toBe('swallow');
    expect(rec.pointerUp(1, 110, 100, 90)).toBe('swallow');
    expect(rec.pointerUp(2, 200, 100, 95)).toBe('swallow');
    expect(rec.isTouching).toBe(false);
  });

  it('pans by how far the midpoint moved, with no zoom while the fingers keep their distance', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerDown(2, 200, 100, 10);
    // The fingers arrive one event at a time; the frame is made once both are there.
    rec.pointerMove(1, 130, 120, 20);
    rec.pointerMove(2, 230, 120, 21);
    rec.flush();
    const last = frames[frames.length - 1]!;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.panX).toBeCloseTo(30);
    expect(frames[0]!.panY).toBeCloseTo(20);
    expect(last.scaleX).toBe(1);
    expect(last.scaleY).toBe(1);
    expect(last.centerX).toBeCloseTo(180);
    expect(last.centerY).toBeCloseTo(120);
  });

  it('zooms by the pinch ratio, around the midpoint, once the distance has changed enough', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 100, 300, 0);
    rec.pointerDown(2, 200, 300, 10);
    // Spread the right finger: 100 -> 120 -> 150 -> 200 px apart.
    rec.pointerMove(2, 220, 300, 20);
    rec.flush();
    rec.pointerMove(2, 250, 300, 30);
    rec.flush();
    rec.pointerMove(2, 300, 300, 40);
    rec.flush();
    const product = frames.reduce((p, f) => p * f.scaleX, 1);
    // Engaged at 120 (the first 20 px of change is not part of it), so the rest, 120 -> 200, is the zoom.
    expect(product).toBeCloseTo(200 / 120);
    expect(frames.every((f) => f.scaleY === 1)).toBe(true);
    expect(frames[frames.length - 1]!.centerX).toBeCloseTo(200);
  });

  it('a pan whose fingers wobble a few pixels does not zoom', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerDown(2, 220, 100, 10);
    rec.pointerMove(2, 226, 100, 20);
    rec.flush();
    rec.pointerMove(1, 95, 100, 30);
    rec.pointerMove(2, 215, 100, 40);
    rec.flush();
    expect(frames.every((f) => f.scaleX === 1)).toBe(true);
  });

  it('zooms the vertical axis from a vertical pinch and leaves the other axis alone', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 300, 100, 0);
    rec.pointerDown(2, 300, 200, 10);
    rec.pointerMove(2, 300, 240, 20);
    rec.flush();
    rec.pointerMove(2, 300, 320, 30);
    rec.flush();
    expect(frames.every((f) => f.scaleX === 1)).toBe(true);
    const product = frames.reduce((p, f) => p * f.scaleY, 1);
    expect(product).toBeGreaterThan(1.5);
  });

  it('does not zoom an axis whose fingers are nearly on top of each other', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerDown(2, 110, 300, 10);
    // Horizontally they are 10 px apart: far under the minimum, so moving them sideways apart is only a pan.
    rec.pointerMove(2, 160, 300, 20);
    rec.flush();
    expect(frames.every((f) => f.scaleX === 1)).toBe(true);
  });

  it('ends the gesture when a finger lifts and ignores the finger left over, a third finger, and the next lone touch only after all are up', () => {
    const { rec, log, frames } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerDown(2, 200, 100, 10);
    expect(rec.pointerDown(3, 300, 100, 15)).toBe('swallow');
    rec.pointerMove(3, 310, 100, 18);
    rec.flush();
    expect(frames).toHaveLength(0);
    rec.pointerUp(1, 100, 100, 20);
    expect(log).toEqual(['multi', 'twoEnd']);
    const before = frames.length;
    rec.pointerMove(2, 260, 100, 30);
    rec.flush();
    expect(frames).toHaveLength(before);
    // Fingers 2 and 3 are still down: a new touch is not a fresh start yet.
    expect(rec.pointerDown(4, 50, 50, 40)).toBe('swallow');
    rec.pointerUp(2, 260, 100, 50);
    rec.pointerUp(3, 310, 100, 51);
    rec.pointerUp(4, 50, 50, 52);
    expect(rec.pointerDown(5, 10, 10, 100)).toBe('pass');
  });

  it('a second finger after a long press does not start a pinch', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.tick(500);
    expect(rec.pointerDown(2, 200, 100, 600)).toBe('swallow');
    expect(log).toEqual(['long 100,100']);
    expect(rec.isTwoFinger).toBe(false);
  });

  it('a pan cancels a double tap that was waiting', () => {
    const { rec, log } = setup();
    rec.pointerDown(1, 50, 50, 0);
    rec.pointerUp(1, 50, 50, 50);
    rec.pointerDown(2, 50, 50, 100);
    rec.pointerDown(3, 150, 50, 110);
    rec.pointerUp(2, 50, 50, 140);
    rec.pointerUp(3, 150, 50, 150);
    rec.pointerDown(4, 50, 50, 200);
    rec.pointerUp(4, 50, 50, 240);
    expect(log).toEqual(['multi', 'twoEnd']);
  });

  it('makes one frame per flush, however many events came, and none when nothing moved', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerDown(2, 200, 100, 10);
    rec.flush();
    expect(frames).toHaveLength(0);
    for (let i = 1; i <= 5; i++) rec.pointerMove(1, 100 + i, 100, 10 + i);
    expect(rec.needsFlush).toBe(true);
    rec.flush();
    rec.flush();
    expect(frames).toHaveLength(1);
    expect(rec.needsFlush).toBe(false);
  });

  it('counts the last move up to a finger\'s lift', () => {
    const { rec, frames } = setup();
    rec.pointerDown(1, 100, 100, 0);
    rec.pointerDown(2, 200, 100, 10);
    rec.pointerUp(1, 140, 100, 20);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.panX).toBeCloseTo(20);
  });

  it('reuses one frame object, so a move allocates nothing', () => {
    const seen = new Set<TwoFingerFrame>();
    const rec = new TouchRecognizer({ onTwoFinger: (f) => seen.add(f) });
    rec.pointerDown(1, 0, 0, 0);
    rec.pointerDown(2, 100, 0, 1);
    for (let i = 0; i < 50; i++) {
      rec.pointerMove(2, 100 + i, 0, 2 + i);
      rec.flush();
    }
    expect(seen.size).toBe(1);
  });
});
