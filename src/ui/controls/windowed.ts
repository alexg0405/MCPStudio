import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

export interface Windowed {
  /** Call from the scrolling element's onScroll. */
  onScroll(): void;
  /** The rows to render: `first` up to (not including) `last`. All of them when the list is short. */
  first: number;
  last: number;
  /** Height of the rows above and below the window (spacers keep the scrollbar honest). */
  padTop: number;
  padBottom: number;
}

/**
 * Windowing for a long list of equal-height rows inside the scrolling element `ref` points at: only the rows near the viewport are in
 * the DOM. Lists shorter than `minRows` render whole (nothing to gain, and the markup stays as it was).
 * The row height is fixed by the caller's CSS; the window re-computes on scroll, resize and when the count changes,
 * and re-renders only when the first or last row changes.
 */
export function useWindowedRows(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  { overscan = 8, minRows = 60 } = {},
): Windowed {
  const [range, setRange] = useState({ first: 0, last: Math.min(count, minRows) });
  const whole = count <= minRows;

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const first = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
    const last = Math.min(count, Math.ceil((el.scrollTop + el.clientHeight) / rowHeight) + overscan);
    setRange((r) => (r.first === first && r.last === last ? r : { first, last }));
  }, [ref, count, rowHeight, overscan]);

  useLayoutEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, update]);

  if (whole) return { onScroll: update, first: 0, last: count, padTop: 0, padBottom: 0 };
  const last = Math.min(count, range.last);
  const first = Math.min(range.first, last);
  return { onScroll: update, first, last, padTop: first * rowHeight, padBottom: (count - last) * rowHeight };
}
