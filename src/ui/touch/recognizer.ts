/**
 * The touch gesture recognizer: pure (no DOM, no timers), so its thresholds are unit tested. A surface (`surface.ts`)
 * feeds it the pointer events of fingers and asks it what they mean:
 *
 * - one finger moves: the editor's current tool gets the events as it would from a mouse (the verdict is `pass`);
 * - a second finger lands: the tool's drag is dropped (`onMultiTouchStart`), and two fingers pan and pinch until every
 *   finger is up (their events are `swallow`ed, so no tool sees them);
 * - one finger rests (about half a second, barely moving): a long press, the touch version of a right-click;
 * - two quick taps close together: a double tap, the touch version of a double-click.
 *
 * Times are in milliseconds from any steady clock (`event.timeStamp`), positions in client pixels.
 */

/** The numbers that decide what a gesture is. */
export interface GestureTuning {
  /** A finger resting this long (ms) without leaving `longPressSlopPx` is a long press. */
  longPressMs: number;
  /** How far (px) a resting finger may drift before it is a drag, not a long press. */
  longPressSlopPx: number;
  /** A tap is a touch shorter than this (ms)... */
  tapMaxMs: number;
  /** ...that stayed within this many px of where it began. */
  tapSlopPx: number;
  /** A second tap within this time (ms) of the first one's lift, and within `doubleTapSlopPx` of it, is a double tap. */
  doubleTapMs: number;
  doubleTapSlopPx: number;
  /** Two fingers have to change their separation by this much (px) along an axis before that axis zooms: a pan that wobbles does not. */
  pinchEngagePx: number;
  /** An axis whose fingers are closer than this (px) does not zoom: a tiny separation turns noise into huge ratios. */
  minAxisSeparationPx: number;
}

/** The thresholds the app uses: close to what touch platforms use (about 500 ms and 10 px for a press). */
export const DEFAULT_TUNING: Readonly<GestureTuning> = {
  longPressMs: 500,
  longPressSlopPx: 10,
  tapMaxMs: 350,
  tapSlopPx: 12,
  doubleTapMs: 320,
  doubleTapSlopPx: 32,
  pinchEngagePx: 10,
  minAxisSeparationPx: 36,
};

/**
 * What two fingers did since the last frame. One object is filled in place for every frame (the editors read it at
 * once and never keep it), so a pointer move allocates nothing.
 */
export interface TwoFingerFrame {
  /** How far the midpoint of the two fingers moved (px); the content follows the fingers, so the view scrolls the other way. */
  panX: number;
  panY: number;
  /** How much the distance between the fingers grew along each axis (1: no change, 2: twice as far apart). */
  scaleX: number;
  scaleY: number;
  /** The midpoint now (client px): the point a zoom keeps still. */
  centerX: number;
  centerY: number;
}

/** What the recognizer reports; every method is optional. */
export interface GestureSink {
  /** A second finger landed: whatever the first finger was doing with the current tool has to be dropped. */
  onMultiTouchStart?(): void;
  /** Two fingers moved (see `TwoFingerFrame`). */
  onTwoFinger?(frame: TwoFingerFrame): void;
  /** One of the two fingers lifted: the pan and pinch are over. */
  onTwoFingerEnd?(): void;
  /**
   * One finger rested: open the context menu there. The tool's drag has to be dropped too (the finger's lift is
   * swallowed, so the tool never sees it).
   */
  onLongPress?(x: number, y: number, pointerId: number): void;
  /** The second tap of a double tap lifted at (`x`, `y`): a double-click there. */
  onDoubleTap?(x: number, y: number): void;
}

/** Whether the editor's own pointer handlers get to see the event. */
export type Verdict = 'pass' | 'swallow';

const NO_ID = -1;

/** The state machine. Create one per touch surface. */
export class TouchRecognizer {
  private readonly frame: TwoFingerFrame = { panX: 0, panY: 0, scaleX: 1, scaleY: 1, centerX: 0, centerY: 0 };

  /** 'one': a finger that goes to the tool; 'two': two fingers pan and pinch; 'spent': the gesture is over, fingers still down. */
  private phase: 'idle' | 'one' | 'two' | 'spent' = 'idle';
  private fingers = 0;

  // The single finger.
  private oneId = NO_ID;
  private oneX = 0;
  private oneY = 0;
  private oneStartX = 0;
  private oneStartY = 0;
  private oneStartTime = 0;
  private hasDrifted = false;
  private hasLongPressed = false;

  // The last tap, for double taps.
  private lastTapTime = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;

  // The two fingers (a, b): where they are, and the separations the pinch is measured from.
  private idA = NO_ID;
  private idB = NO_ID;
  private ax = 0;
  private ay = 0;
  private bx = 0;
  private by = 0;
  private lastMidX = 0;
  private lastMidY = 0;
  private startSepX = 0;
  private startSepY = 0;
  private lastSepX = 0;
  private lastSepY = 0;
  private isZoomingX = false;
  private isZoomingY = false;
  private hasPendingMove = false;

  constructor(
    private readonly sink: GestureSink,
    private readonly tuning: Readonly<GestureTuning> = DEFAULT_TUNING,
  ) {}

  /** The time (same clock as the events) at which `tick` should be called to catch a long press, or null when none is pending. */
  nextDeadline(): number | null {
    return this.isLongPressPending() ? this.oneStartTime + this.tuning.longPressMs : null;
  }

  /** True while any finger is down. */
  get isTouching(): boolean {
    return this.fingers > 0;
  }

  /** True while two fingers are panning or pinching. */
  get isTwoFinger(): boolean {
    return this.phase === 'two';
  }

  /** A finger landed. */
  pointerDown(id: number, x: number, y: number, time: number): Verdict {
    this.fingers++;
    if (this.phase === 'idle') {
      this.beginOne(id, x, y, time);
      return 'pass';
    }
    if (this.phase === 'one') {
      this.beginTwo(id, x, y);
      return 'swallow';
    }
    // A third finger, or any finger after the gesture ended, does nothing.
    return 'swallow';
  }

  /** A finger moved. */
  pointerMove(id: number, x: number, y: number, time: number): Verdict {
    if (this.phase === 'one') {
      if (id !== this.oneId) return 'swallow';
      this.oneX = x;
      this.oneY = y;
      this.checkDrift(x, y);
      this.tick(time);
      return this.hasLongPressed ? 'swallow' : 'pass';
    }
    if (this.phase === 'two') {
      this.placeFinger(id, x, y);
      return 'swallow';
    }
    return this.phase === 'idle' ? 'pass' : 'swallow';
  }

  /**
   * Reports what two fingers did since the last report. Fingers move one pointer event at a time, and in between, one
   * finger has moved and the other has not (which looks like a pinch), so the surface calls this once per animation
   * frame, when both have caught up, not after every event.
   */
  flush(): void {
    if (this.phase !== 'two' || !this.hasPendingMove) return;
    this.hasPendingMove = false;
    this.reportTwo();
  }

  /** True when a finger moved since the last `flush` (the surface asks for a frame to call it in). */
  get needsFlush(): boolean {
    return this.phase === 'two' && this.hasPendingMove;
  }

  /** A finger lifted. */
  pointerUp(id: number, x: number, y: number, time: number): Verdict {
    return this.end(id, x, y, time, true);
  }

  /** A finger was taken away by the browser (a system gesture, a call). */
  pointerCancel(id: number): Verdict {
    return this.end(id, 0, 0, 0, false);
  }

  /** Lets time pass: a finger that has rested long enough becomes a long press. */
  tick(time: number): void {
    if (!this.isLongPressPending() || time - this.oneStartTime < this.tuning.longPressMs) return;
    this.hasLongPressed = true;
    this.sink.onLongPress?.(this.oneX, this.oneY, this.oneId);
  }

  private isLongPressPending(): boolean {
    return this.phase === 'one' && !this.hasDrifted && !this.hasLongPressed;
  }

  private beginOne(id: number, x: number, y: number, time: number): void {
    this.phase = 'one';
    this.oneId = id;
    this.oneX = this.oneStartX = x;
    this.oneY = this.oneStartY = y;
    this.oneStartTime = time;
    this.hasDrifted = false;
    this.hasLongPressed = false;
  }

  private checkDrift(x: number, y: number): void {
    if (this.hasDrifted) return;
    if (Math.hypot(x - this.oneStartX, y - this.oneStartY) > this.tuning.longPressSlopPx) this.hasDrifted = true;
  }

  private beginTwo(id: number, x: number, y: number): void {
    // A long press that already fired took the first finger over: it does not become half of a pinch.
    if (this.hasLongPressed) {
      this.phase = 'spent';
      return;
    }
    this.phase = 'two';
    this.lastTapTime = -Infinity;
    this.idA = this.oneId;
    this.ax = this.oneX;
    this.ay = this.oneY;
    this.idB = id;
    this.bx = x;
    this.by = y;
    this.lastMidX = (this.ax + this.bx) / 2;
    this.lastMidY = (this.ay + this.by) / 2;
    this.startSepX = this.lastSepX = Math.abs(this.ax - this.bx);
    this.startSepY = this.lastSepY = Math.abs(this.ay - this.by);
    this.isZoomingX = false;
    this.isZoomingY = false;
    this.hasPendingMove = false;
    this.sink.onMultiTouchStart?.();
  }

  private placeFinger(id: number, x: number, y: number): void {
    if (id === this.idA) {
      this.ax = x;
      this.ay = y;
    } else if (id === this.idB) {
      this.bx = x;
      this.by = y;
    } else return;
    this.hasPendingMove = true;
  }

  private reportTwo(): void {
    const midX = (this.ax + this.bx) / 2;
    const midY = (this.ay + this.by) / 2;
    const sepX = Math.abs(this.ax - this.bx);
    const sepY = Math.abs(this.ay - this.by);
    const frame = this.frame;
    frame.panX = midX - this.lastMidX;
    frame.panY = midY - this.lastMidY;
    frame.scaleX = this.axisScale('x', sepX);
    frame.scaleY = this.axisScale('y', sepY);
    frame.centerX = midX;
    frame.centerY = midY;
    this.lastMidX = midX;
    this.lastMidY = midY;
    this.lastSepX = sepX;
    this.lastSepY = sepY;
    this.sink.onTwoFinger?.(frame);
  }

  /** The ratio one axis of the pinch grew by since the last frame (1 until the axis is engaged and wide enough). */
  private axisScale(axis: 'x' | 'y', now: number): number {
    const isX = axis === 'x';
    const start = isX ? this.startSepX : this.startSepY;
    const last = isX ? this.lastSepX : this.lastSepY;
    const { pinchEngagePx, minAxisSeparationPx } = this.tuning;
    if (!(isX ? this.isZoomingX : this.isZoomingY)) {
      if (Math.abs(now - start) < pinchEngagePx || start < minAxisSeparationPx) return 1;
      // From here on the axis zooms; this frame only engages it, so there is no jump by the distance already moved.
      if (isX) this.isZoomingX = true;
      else this.isZoomingY = true;
      return 1;
    }
    return now >= minAxisSeparationPx && last >= minAxisSeparationPx ? now / last : 1;
  }

  private end(id: number, x: number, y: number, time: number, isLift: boolean): Verdict {
    this.fingers = Math.max(0, this.fingers - 1);
    if (this.phase === 'one' && id === this.oneId) {
      const wasLongPress = this.hasLongPressed;
      this.phase = this.fingers === 0 ? 'idle' : 'spent';
      if (isLift && !wasLongPress) this.maybeTap(x, y, time);
      return wasLongPress ? 'swallow' : 'pass';
    }
    if (this.phase === 'two' && (id === this.idA || id === this.idB)) {
      // What the fingers did up to their lift still counts.
      if (isLift) this.placeFinger(id, x, y);
      this.flush();
      this.phase = this.fingers === 0 ? 'idle' : 'spent';
      this.sink.onTwoFingerEnd?.();
    } else if (this.phase === 'spent' && this.fingers === 0) {
      this.phase = 'idle';
    }
    return 'swallow';
  }

  /** A finger lifted without having gone far or stayed long: a tap, and maybe the second of a double tap. */
  private maybeTap(x: number, y: number, time: number): void {
    const isTap =
      time - this.oneStartTime <= this.tuning.tapMaxMs &&
      Math.hypot(x - this.oneStartX, y - this.oneStartY) <= this.tuning.tapSlopPx;
    if (!isTap) {
      this.lastTapTime = -Infinity;
      return;
    }
    const isSecond =
      time - this.lastTapTime <= this.tuning.doubleTapMs &&
      Math.hypot(x - this.lastTapX, y - this.lastTapY) <= this.tuning.doubleTapSlopPx;
    if (isSecond) {
      this.lastTapTime = -Infinity;
      this.sink.onDoubleTap?.(x, y);
      return;
    }
    this.lastTapTime = time;
    this.lastTapX = x;
    this.lastTapY = y;
  }
}
