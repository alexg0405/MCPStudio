/** The horizontal scrollbar under a timeline editor: where its thumb sits and dragging it. */
import { clamp, type Viewport } from './viewport';

/** The thumb never gets narrower than this (px), however long the song is, so it stays easy to grab. */
export const MIN_THUMB_WIDTH = 24;

/**
 * Sizes and places the thumb for the view's scroll. `trackWidth` is measured when the layout changes (never here, so
 * the frame loop does not ask the layout for it).
 */
export function placeScrollThumb(thumb: HTMLElement, vp: Viewport, totalTicks: number, trackWidth: number): void {
  const visibleTicks = vp.width / vp.pxPerTick;
  const thumbWidth = Math.max(MIN_THUMB_WIDTH, Math.min(trackWidth, (visibleTicks / totalTicks) * trackWidth));
  const left = totalTicks > visibleTicks ? (vp.scrollTick / (totalTicks - visibleTicks)) * (trackWidth - thumbWidth) : 0;
  thumb.style.width = `${thumbWidth}px`;
  thumb.style.transform = `translateX(${left}px)`;
}

/** What a thumb drag needs to know. */
export interface ThumbDrag {
  thumb: HTMLElement;
  /** The scrollbar's track, which the thumb slides in. */
  track: HTMLElement;
  vp: Viewport;
  /** How long the scrollable area is (ticks). */
  totalTicks: number;
  /** Called after each move, once `vp.scrollTick` is set (the editor redraws and holds the playhead follow). */
  onScrolled(): void;
}

/** Starts dragging the thumb from its pointerdown: the view follows the pointer until the button is let go. */
export function startThumbDrag(event: PointerEvent, drag: ThumbDrag): void {
  event.preventDefault();
  event.stopPropagation();
  const { thumb, vp, totalTicks } = drag;
  thumb.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startScrollTick = vp.scrollTick;
  const visibleTicks = vp.width / vp.pxPerTick;
  const trackWidth = drag.track.getBoundingClientRect().width;
  const thumbWidth = thumb.getBoundingClientRect().width;
  const onMove = (move: PointerEvent): void => {
    const fraction = (move.clientX - startX) / Math.max(1, trackWidth - thumbWidth);
    vp.scrollTick = clamp(startScrollTick + fraction * (totalTicks - visibleTicks), 0, Math.max(0, totalTicks - visibleTicks));
    drag.onScrolled();
  };
  const onUp = (): void => {
    thumb.removeEventListener('pointermove', onMove);
    thumb.removeEventListener('pointerup', onUp);
  };
  thumb.addEventListener('pointermove', onMove);
  thumb.addEventListener('pointerup', onUp);
}
