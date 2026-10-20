import { describe, expect, it } from 'vitest';
import { FOLLOW_ANCHOR, FOLLOW_EDGE, FOLLOW_LEAD, FOLLOW_QUIET_MS, FOLLOW_RESUME_MS, PlayheadFollow, type FollowFrame } from './follow';

const VISIBLE = 1000;
const base: FollowFrame = {
  now: 1000,
  enabled: true,
  playing: true,
  playhead: 0,
  scrollTick: 0,
  visible: VISIBLE,
  maxScroll: 100_000,
  wrapEnd: Infinity,
  busy: false,
};

/** Runs frames 16 ms apart until it leaves the view alone; the scroll it ends on. */
function settle(f: PlayheadFollow, frame: Partial<FollowFrame>, start = base.now): { scroll: number; frames: number } {
  let scroll = frame.scrollTick ?? 0;
  let now = start;
  for (let i = 0; i < 200; i++) {
    const next = f.step({ ...base, ...frame, scrollTick: scroll, now });
    if (next === null) return { scroll, frames: i };
    scroll = next;
    now += 16;
  }
  throw new Error('never settled');
}

describe('PlayheadFollow', () => {
  it('leaves the view alone until the playhead nears the right edge', () => {
    const f = new PlayheadFollow();
    expect(f.step({ ...base, playhead: 0.5 * VISIBLE })).toBeNull();
    expect(f.step({ ...base, playhead: (FOLLOW_EDGE - 0.01) * VISIBLE })).toBeNull();
  });

  it('glides a page on so the playhead sits near the left (a few frames, not one jump)', () => {
    const f = new PlayheadFollow();
    const playhead = 0.9 * VISIBLE;
    const first = f.step({ ...base, playhead });
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(playhead - FOLLOW_LEAD * VISIBLE);
    const { scroll, frames } = settle(f, { playhead, scrollTick: first! });
    expect(scroll).toBeCloseTo(playhead - FOLLOW_LEAD * VISIBLE, 6);
    expect(frames).toBeGreaterThan(3);
    expect(frames).toBeLessThan(40);
  });

  it('with less motion the page turns in one jump, in either style', () => {
    for (const style of ['page', 'smooth'] as const) {
      const f = new PlayheadFollow();
      const playhead = 0.9 * VISIBLE;
      const goal = playhead - FOLLOW_LEAD * VISIBLE;
      // One frame lands on the new page; the next leaves the view alone (no glide, no sliding with the playhead).
      expect(f.step({ ...base, playhead, style, reducedMotion: true }), style).toBe(goal);
      expect(f.step({ ...base, playhead: playhead + 10, scrollTick: goal, style, reducedMotion: true }), style).toBeNull();
    }
  });

  it('brings a playhead that jumped off-screen straight back (a loop or a seek)', () => {
    const f = new PlayheadFollow();
    // Looped back to the start while the view shows bars further on.
    expect(f.step({ ...base, playhead: 100, scrollTick: 5000 })).toBe(0);
    expect(f.step({ ...base, playhead: 20_000, scrollTick: 0 })).toBe(20_000 - FOLLOW_LEAD * VISIBLE);
  });

  it('does not turn the page when the loop end already shows', () => {
    const f = new PlayheadFollow();
    expect(f.step({ ...base, playhead: 0.95 * VISIBLE, wrapEnd: VISIBLE })).toBeNull();
  });

  it('stays inside the scroll range', () => {
    const f = new PlayheadFollow();
    const { scroll } = settle(f, { playhead: 0.9 * VISIBLE, maxScroll: 300 });
    expect(scroll).toBe(300);
    expect(f.step({ ...base, playhead: 0.95 * VISIBLE + 300, scrollTick: 300, maxScroll: 300 })).toBeNull();
  });

  it('does nothing when off, stopped, busy, or the playhead is not in this view', () => {
    const f = new PlayheadFollow();
    const far = { playhead: 5000 };
    expect(f.step({ ...base, ...far, enabled: false })).toBeNull();
    expect(f.step({ ...base, ...far, playing: false })).toBeNull();
    expect(f.step({ ...base, ...far, busy: true })).toBeNull();
    expect(f.step({ ...base, playhead: NaN })).toBeNull();
    // Let go: it catches up at once.
    expect(f.step({ ...base, ...far })).toBe(5000 - FOLLOW_LEAD * VISIBLE);
  });

  it('after a hand scroll it waits until the playhead is back in view', () => {
    const f = new PlayheadFollow();
    f.step({ ...base, playhead: 100 });
    f.userScrolled(base.now);
    // Scrolled ahead: the playhead is off to the left.
    const later = base.now + FOLLOW_QUIET_MS + 100;
    expect(f.step({ ...base, now: later, playhead: 200, scrollTick: 3000 })).toBeNull();
    expect(f.step({ ...base, now: later + 16, playhead: 2900, scrollTick: 3000 })).toBeNull();
    // It enters the view: following resumes and turns the page at the edge.
    expect(f.step({ ...base, now: later + 32, playhead: 3100, scrollTick: 3000 })).toBeNull();
    expect(f.step({ ...base, now: later + 48, playhead: 3950, scrollTick: 3000 })).toBeGreaterThan(3000);
  });

  it('a hand scroll that keeps the playhead in view still holds for a moment', () => {
    const f = new PlayheadFollow();
    f.step({ ...base, playhead: 100 });
    f.userScrolled(base.now);
    expect(f.step({ ...base, now: base.now + 100, playhead: 950 })).toBeNull();
    expect(f.step({ ...base, now: base.now + FOLLOW_QUIET_MS + 1, playhead: 950 })).not.toBeNull();
  });

  it('playing again ends the hold', () => {
    const f = new PlayheadFollow();
    f.step({ ...base, playhead: 100 });
    f.userScrolled(base.now);
    f.step({ ...base, now: base.now + 16, playing: false });
    expect(f.step({ ...base, now: base.now + 32, playhead: 8000 })).toBe(8000 - FOLLOW_LEAD * VISIBLE);
  });
});

describe('PlayheadFollow, smooth style', () => {
  const smooth: FollowFrame = { ...base, style: 'smooth' };

  it('leaves the view alone until the playhead reaches the anchor, then moves with it every frame', () => {
    const f = new PlayheadFollow();
    expect(f.step({ ...smooth, playhead: 0.2 * VISIBLE })).toBeNull();
    expect(f.step({ ...smooth, playhead: (FOLLOW_ANCHOR - 0.01) * VISIBLE })).toBeNull();
    // Playing on: each frame the view keeps the playhead at the anchor, no page turns.
    let scroll = 0;
    for (let i = 1; i <= 30; i++) {
      const playhead = FOLLOW_ANCHOR * VISIBLE + i * 10;
      const next = f.step({ ...smooth, now: base.now + i * 16, playhead, scrollTick: scroll });
      expect(next).toBeCloseTo(playhead - FOLLOW_ANCHOR * VISIBLE, 6);
      scroll = next!;
    }
  });

  it('never scrolls back while playing forward, and stops at the end of the scroll range', () => {
    const f = new PlayheadFollow();
    expect(f.step({ ...smooth, playhead: 600, scrollTick: 500 })).toBeNull();
    expect(f.step({ ...smooth, playhead: 0.9 * VISIBLE + 300, scrollTick: 300, maxScroll: 300 })).toBeNull();
  });

  it('glides back to the anchor after a hand scroll left the playhead far right, instead of jumping', () => {
    const f = new PlayheadFollow();
    f.userScrolled(base.now);
    const later = base.now + FOLLOW_QUIET_MS + 1;
    const first = f.step({ ...smooth, now: later, playhead: 0.9 * VISIBLE, scrollTick: 0 })!;
    const goal = 0.9 * VISIBLE - FOLLOW_ANCHOR * VISIBLE;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(goal);
    const end = settle(f, { ...smooth, playhead: 0.9 * VISIBLE }, later + 16);
    expect(end.scroll).toBeCloseTo(goal, 6);
  });

  it('holds still when the loop end shows, and snaps back to a playhead that jumped off-screen', () => {
    const f = new PlayheadFollow();
    expect(f.step({ ...smooth, playhead: 0.7 * VISIBLE, wrapEnd: VISIBLE })).toBeNull();
    expect(f.step({ ...smooth, playhead: 20_000, scrollTick: 0 })).toBe(20_000 - FOLLOW_ANCHOR * VISIBLE);
  });
});

describe('PlayheadFollow, zooming and hand scrolls', () => {
  const smooth: FollowFrame = { ...base, style: 'smooth' };

  it('zooming does not stop following: the view glides back to the playhead, even when the zoom left it off-screen', () => {
    const f = new PlayheadFollow();
    f.step({ ...smooth, playhead: 5000, scrollTick: 5000 - FOLLOW_ANCHOR * VISIBLE });
    // Zoomed in around the middle: the playhead is now left of the view.
    f.zoomed();
    const goal = 5000 - FOLLOW_ANCHOR * VISIBLE;
    const first = f.step({ ...smooth, now: base.now + 16, playhead: 5000, scrollTick: 5800 })!;
    expect(first).toBeLessThan(5800);
    expect(first).toBeGreaterThan(goal);
    const end = settle(f, { ...smooth, playhead: 5000, scrollTick: first }, base.now + 32);
    expect(end.scroll).toBeCloseTo(goal, 6);
  });

  it('a hand scroll that leaves the playhead off-screen holds, then follows again by itself', () => {
    const f = new PlayheadFollow();
    f.step({ ...smooth, now: base.now - 16, playhead: 100 }); // already playing
    f.userScrolled(base.now);
    const off = { ...smooth, playhead: 20_000, scrollTick: 0 };
    expect(f.step({ ...off, now: base.now + FOLLOW_QUIET_MS + 10 })).toBeNull();
    expect(f.step({ ...off, now: base.now + FOLLOW_RESUME_MS - 10 })).toBeNull();
    // Past the hold: on its way back, gliding rather than jumping.
    const back = f.step({ ...off, now: base.now + FOLLOW_RESUME_MS + 10 })!;
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(20_000 - FOLLOW_ANCHOR * VISIBLE);
  });
});
