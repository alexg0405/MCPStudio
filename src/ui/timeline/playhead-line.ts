/** The playhead: a thin line over the grid that moves on the frame loop without any React render. */
import type { Viewport } from './viewport';

/** Places an element as the playhead line, on whole device pixels, and touches the DOM only when it has moved. */
export class PlayheadLine {
  private lastX = NaN;

  /**
   * @param element  the line (placed at the corner of the editor by its stylesheet)
   * @param gridLeft how far the grid starts from the left of that corner (the keys or track headers beside it), px
   */
  constructor(
    private readonly element: HTMLElement,
    private readonly gridLeft: number,
  ) {}

  /** Moves the line to view x `x` (NaN, or outside the view: hidden). */
  place(vp: Viewport, x: number): void {
    // The line sits on a whole device pixel, like the grid it is drawn over.
    const snapped = Number.isFinite(x) ? vp.snap(x) : NaN;
    if (snapped === this.lastX) return;
    this.lastX = snapped;
    const style = this.element.style;
    if (!Number.isFinite(snapped) || snapped < 0 || snapped > vp.width) {
      style.display = 'none';
      return;
    }
    style.display = 'block';
    style.transform = `translateX(${this.gridLeft + snapped}px)`;
  }
}
