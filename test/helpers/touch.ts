/**
 * Real fingers for browser tests: touches sent through Chrome's own input pipeline (DevTools `Input.dispatchTouchEvent`), so
 * the page gets genuine `pointerType: 'touch'` pointer events with implicit pointer capture, touch-action and all, the way
 * a tablet would send them. (Synthetic `new PointerEvent(...)` cannot capture a pointer that does not exist.)
 *
 * The test page runs in an iframe of Vitest's page; the test viewport is set with `page.viewport`, and the iframe sits at
 * the origin at full size, so page coordinates are screen coordinates.
 */
import { cdp } from 'vitest/browser';

/** A fingertip on the screen, in client pixels of the test page. */
export interface Point {
  x: number;
  y: number;
}

/** A set of fingers on the screen. Each is named by a number the test chooses. */
export class Fingers {
  private readonly down = new Map<number, Point>();

  /** The position of each finger now (a copy). */
  positions(): Map<number, Point> {
    return new Map(this.down);
  }

  /** A finger lands. */
  async press(id: number, at: Point): Promise<void> {
    this.down.set(id, { ...at });
    await this.send('touchStart');
  }

  /**
   * Several fingers land in one touch event (as two fingers of one hand do). A test that puts fingers down one await at a
   * time can be slowed past the 500 ms of a long press by a busy machine, which would make the first finger a long press.
   */
  async pressTogether(at: Record<number, Point>): Promise<void> {
    for (const [id, point] of Object.entries(at)) this.down.set(Number(id), { ...point });
    await this.send('touchStart');
  }

  /**
   * A finger lands and makes its first move at once: both events are sent before either is waited for, so the move comes
   * well inside the long-press time whatever the load. Then it carries on to `to` in `steps` moves.
   */
  async pressAndDrag(id: number, from: Point, to: Point, steps = 6): Promise<void> {
    const first = { x: from.x + (to.x - from.x) / steps, y: from.y + (to.y - from.y) / steps };
    await Promise.all([this.press(id, from), this.move({ [id]: first })]);
    await nextFrame();
    const remaining = steps - 1;
    for (let i = 1; i <= remaining; i++) {
      await this.move({ [id]: { x: first.x + ((to.x - first.x) * i) / remaining, y: first.y + ((to.y - first.y) * i) / remaining } });
      await nextFrame();
    }
  }

  /** Fingers move to new places: `to` lists the ones that move (others stay). */
  async move(to: Record<number, Point>): Promise<void> {
    for (const [id, at] of Object.entries(to)) this.down.set(Number(id), { ...at });
    await this.send('touchMove');
  }

  /** A finger lifts. */
  async lift(id: number): Promise<void> {
    const at = this.down.get(id);
    if (!at) return;
    // For touchEnd the points listed are the ones that lift.
    this.down.delete(id);
    await this.send('touchEnd', [[id, at]]);
  }

  /** Every finger lifts. */
  async liftAll(): Promise<void> {
    if (this.down.size === 0) return;
    const all = [...this.down.entries()];
    this.down.clear();
    await this.send('touchEnd', all);
  }

  /** One finger drags in `steps` moves from where it is to `to`, a frame apart. */
  async drag(id: number, to: Point, steps = 6): Promise<void> {
    const from = this.down.get(id);
    if (!from) throw new Error(`finger ${id} is not down`);
    for (let i = 1; i <= steps; i++) {
      await this.move({ [id]: { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps } });
      await nextFrame();
    }
  }

  /** Two fingers move together (a pan) or apart (a pinch) in `steps` moves, each finger by its own end point. */
  async dragTogether(a: { id: number; to: Point }, b: { id: number; to: Point }, steps = 8): Promise<void> {
    const fromA = this.down.get(a.id);
    const fromB = this.down.get(b.id);
    if (!fromA || !fromB) throw new Error('both fingers must be down');
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.move({
        [a.id]: { x: fromA.x + (a.to.x - fromA.x) * t, y: fromA.y + (a.to.y - fromA.y) * t },
        [b.id]: { x: fromB.x + (b.to.x - fromB.x) * t, y: fromB.y + (b.to.y - fromB.y) * t },
      });
      await nextFrame();
    }
  }

  /**
   * Two quick taps, sent without waiting between them: the browser's own timestamps are a few milliseconds apart however busy
   * the machine is (a test that waits between the taps can be slowed past the 320 ms of a double tap).
   */
  async doubleTap(id: number, at: Point): Promise<void> {
    await Promise.all([this.press(id, at), this.lift(id), this.press(id, at), this.lift(id)]);
  }

  /** A quick tap: down and up. */
  async tap(id: number, at: Point): Promise<void> {
    await this.press(id, at);
    await this.lift(id);
  }

  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', only?: Array<[number, Point]>): Promise<void> {
    const touchPoints = (only ?? [...this.down.entries()]).map(([id, p]) => ({ x: p.x, y: p.y, id }));
    await cdp().send('Input.dispatchTouchEvent', { type, touchPoints });
  }
}

/** The middle of an element on the screen. */
export function centerOf(element: Element): Point {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** A point inside an element, `x` and `y` px from its top left corner. */
export function insideOf(element: Element, x: number, y: number): Point {
  const box = element.getBoundingClientRect();
  return { x: box.left + x, y: box.top + y };
}

export const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ok()` is true (polling a frame apart), or throws after `ms`. */
export async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await sleep(16);
  }
}
