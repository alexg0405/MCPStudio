/**
 * Follow the playhead (FL's auto-scroll) for timeline editors, in one of two styles:
 *  - smooth (the default): once the playhead reaches `FOLLOW_ANCHOR` of the width, the view moves with it
 *    every frame, so the song slides by under a steady playhead;
 *  - page: when the playhead nears the right edge the view glides one page on, so it sits near the left again.
 * A playhead that jumps off-screen (a loop, a seek) is brought straight back.
 *
 * It never fights the user: it holds still while they drag, select or have a menu open (and picks up
 * when they let go), and after they scroll or zoom by hand it waits until the playhead is back in view
 * or playback starts again. Pure arithmetic per frame, run from the editor's frame loop: no React.
 */

/** Where the page turns: the playhead at this fraction of the width. */
export const FOLLOW_EDGE = 0.88;
/** Where the playhead lands after a page turn. */
export const FOLLOW_LEAD = 0.15;
/** How long a hand scroll keeps following away even when the playhead is still in view (ms). */
export const FOLLOW_QUIET_MS = 1200;
/** How long the glide to the next page takes (ms). */
export const FOLLOW_GLIDE_MS = 240;
/** Smooth style: where the playhead stays once the view moves with it (fraction of the width). */
export const FOLLOW_ANCHOR = 0.4;
/** Smooth style: a gap to the anchor larger than this (fraction of the width) is closed with a glide, not a jump. */
const CATCH_UP = 0.05;

export type FollowStyle = 'smooth' | 'page';

export interface FollowFrame {
  /** Frame time (performance.now() based, like requestAnimationFrame's). */
  now: number;
  /** The "Follow playhead" preference. */
  enabled: boolean;
  playing: boolean;
  /** The playhead in this view's ticks; NaN when it isn't shown here. */
  playhead: number;
  /** Tick at the left edge, and how many ticks the view shows. */
  scrollTick: number;
  visible: number;
  /** The largest scrollTick allowed. */
  maxScroll: number;
  /**
   * Where playback wraps back (a loop region's or the pattern's end; Infinity if it doesn't): when it
   * already shows, the page doesn't turn, since the playhead comes back around instead.
   */
  wrapEnd: number;
  /** The user is dragging, selecting or has a menu open. */
  busy: boolean;
  /** Smooth (move with the playhead) or page (turn a page at the edge); page when left out. */
  style?: FollowStyle;
}

export class PlayheadFollow {
  private wasPlaying = false;
  /** Scrolled by hand: wait until the playhead shows again (or playback restarts). */
  private held = false;
  private quietUntil = 0;
  /** Gliding to the next page: from where, to where, since when. */
  private glide: { from: number; to: number; t0: number } | null = null;

  /** The user scrolled or zoomed by hand (wheel, scrollbar, zoom buttons, middle-drag). */
  userScrolled(now = performance.now()): void {
    this.held = true;
    this.quietUntil = now + FOLLOW_QUIET_MS;
    this.glide = null;
  }

  /** The scrollTick to show this frame, or null to leave the view where it is. */
  step(f: FollowFrame): number | null {
    if (f.playing && !this.wasPlaying) {
      // Play (again): follow from the start, whatever the user scrolled before.
      this.held = false;
      this.quietUntil = 0;
    }
    this.wasPlaying = f.playing;
    if (!f.enabled || !f.playing || !Number.isFinite(f.playhead) || f.visible <= 0 || f.busy || f.now < this.quietUntil) {
      this.glide = null;
      return null;
    }
    const at = (f.playhead - f.scrollTick) / f.visible;
    const inView = at >= 0 && at <= 1;
    if (this.held) {
      if (!inView) return null;
      this.held = false;
    }
    if (f.style === 'smooth') return this.smooth(f, at, inView);
    const goal = Math.max(0, Math.min(f.maxScroll, f.playhead - FOLLOW_LEAD * f.visible));
    if (!inView) {
      // A loop or a seek put it off-screen: straight back, no glide across the song.
      this.glide = null;
      return Math.abs(goal - f.scrollTick) > 1e-6 ? goal : null;
    }
    if (!this.glide) {
      const wrapShows = f.wrapEnd <= f.scrollTick + f.visible;
      if (at < FOLLOW_EDGE || wrapShows || goal <= f.scrollTick) return null;
      // The page it turns to is set now (the playhead moves on a little during the glide); it starts moving this frame.
      this.glide = { from: f.scrollTick, to: goal, t0: f.now - 16 };
    }
    const g = this.glide;
    const t = (f.now - g.t0) / FOLLOW_GLIDE_MS;
    if (t >= 1) {
      this.glide = null;
      return g.to;
    }
    // Ease out: quick start, gentle landing.
    return g.from + (g.to - g.from) * (1 - (1 - Math.max(0, t)) ** 3);
  }

  /** Smooth style: keep the playhead at the anchor once it gets there, never scrolling back. */
  private smooth(f: FollowFrame, at: number, inView: boolean): number | null {
    const goal = Math.max(0, Math.min(f.maxScroll, f.playhead - FOLLOW_ANCHOR * f.visible));
    if (!inView) {
      this.glide = null;
      return Math.abs(goal - f.scrollTick) > 1e-6 ? goal : null;
    }
    // The loop's end already shows: the playhead comes back around, the view stays.
    if (f.wrapEnd <= f.scrollTick + f.visible) {
      this.glide = null;
      return null;
    }
    if (this.glide) {
      // Catching up after a hand scroll: aim at where the anchor is now, so the glide lands on a moving playhead.
      const g = this.glide;
      const t = (f.now - g.t0) / FOLLOW_GLIDE_MS;
      if (t >= 1) {
        this.glide = null;
        return goal;
      }
      return g.from + (goal - g.from) * (1 - (1 - Math.max(0, t)) ** 3);
    }
    if (goal <= f.scrollTick) return null; // not at the anchor yet (the start of the song)
    if (at - FOLLOW_ANCHOR > CATCH_UP) {
      this.glide = { from: f.scrollTick, to: goal, t0: f.now - 16 };
      return this.smooth(f, at, inView);
    }
    return goal;
  }
}
