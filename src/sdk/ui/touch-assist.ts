// Help for dragging a control with a finger: a dead zone so a resting finger changes nothing, and two ways to go finer.
//
// With a mouse a knob or fader drags straight away and Shift makes it fine. A finger covers what it controls and has no
// Shift key, so while one finger drags a control:
//   - a second finger put down anywhere makes the drag fine (a tenth as fast) until it lifts;
//   - or the finger first rests for half a second without moving: the drag that follows is fine, and when it lifts without
//     having moved, the control's menu opens (the touch version of a right-click).
// A control creates one `TouchAssist`, calls `start` on pointerdown, `move` on every pointermove, `end` on pointerup, and
// reads `isFine` next to the Shift key. Mouse and pen events make it do nothing at all.

/** A finger that moves less than this (px) from where it landed is still resting, not dragging. */
const DRAG_SLOP_PX = 6;
/** A finger that rests this long (ms) starts a fine drag, and a menu if it lifts without moving. */
const REST_MS = 500;
/** The buzz (ms) that tells the finger the rest was noticed, on devices that can. */
const REST_BUZZ_MS = 12;

/** The parts of a pointer event the helper reads. */
interface TouchPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** What `move` says about the dragged finger. */
export type DragPhase =
  /** Still inside the dead zone: the control changes nothing yet. */
  | 'resting'
  /** The first move past the dead zone: the control starts its drag from here (anchor at the finger now). */
  | 'started'
  /** Dragging. */
  | 'dragging';

/** What the control hears from the assist. */
export interface TouchAssistHooks {
  /** `isFine` changed (a second finger came or went, or the rest was noticed): the control re-anchors its drag. */
  onFineChange(): void;
}

/** Touch help for one control; see the file's comment. */
export class TouchAssist {
  /** True while the drag should be fine: a second finger is down, or the finger rested first. */
  isFine = false;
  private pointerId = -1;
  private hasMoved = false;
  private hasRested = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private timer = 0;
  private extraFingers = new Set<number>();

  constructor(private readonly hooks: TouchAssistHooks) {}

  /** The dragged finger landed. Returns true when it is a touch (so the control knows the assist is in play). */
  start(event: TouchPointer): boolean {
    this.stop();
    if (event.pointerType !== 'touch') return false;
    this.pointerId = event.pointerId;
    this.hasMoved = false;
    this.hasRested = false;
    this.startX = this.lastX = event.clientX;
    this.startY = this.lastY = event.clientY;
    this.timer = window.setTimeout(() => this.rest(), REST_MS);
    document.addEventListener('pointerdown', this.onOtherDown, true);
    document.addEventListener('pointerup', this.onOtherUp, true);
    document.addEventListener('pointercancel', this.onOtherUp, true);
    return true;
  }

  /** The dragged finger moved. Mouse and pen are always `dragging` (no dead zone). */
  move(event: TouchPointer): DragPhase {
    if (this.pointerId < 0) return 'dragging';
    if (event.pointerId !== this.pointerId) return 'resting';
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (this.hasMoved) return 'dragging';
    if (Math.hypot(event.clientX - this.startX, event.clientY - this.startY) <= DRAG_SLOP_PX) return 'resting';
    this.hasMoved = true;
    window.clearTimeout(this.timer);
    return 'started';
  }

  /**
   * The dragged finger lifted. Returns where the control's menu should open when the finger rested and never moved
   * afterwards (a long press), else null.
   */
  end(): { x: number; y: number } | null {
    const wasRestingPress = this.pointerId >= 0 && this.hasRested && !this.hasMoved;
    const at = wasRestingPress ? { x: this.lastX, y: this.lastY } : null;
    this.stop();
    return at;
  }

  /** Forgets the drag (it ended, or the control went away). */
  stop(): void {
    window.clearTimeout(this.timer);
    document.removeEventListener('pointerdown', this.onOtherDown, true);
    document.removeEventListener('pointerup', this.onOtherUp, true);
    document.removeEventListener('pointercancel', this.onOtherUp, true);
    this.pointerId = -1;
    this.extraFingers.clear();
    this.setFine(false);
  }

  private rest(): void {
    this.hasRested = true;
    this.setFine(true);
    navigator.vibrate?.(REST_BUZZ_MS);
  }

  private readonly onOtherDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || event.pointerId === this.pointerId) return;
    this.extraFingers.add(event.pointerId);
    this.setFine(true);
  };

  private readonly onOtherUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || !this.extraFingers.delete(event.pointerId)) return;
    // The finger that rested keeps its fine drag; a second finger's lift ends it.
    if (this.extraFingers.size === 0) this.setFine(this.hasRested);
  };

  private setFine(isFine: boolean): void {
    if (this.isFine === isFine) return;
    this.isFine = isFine;
    this.hooks.onFineChange();
  }
}
