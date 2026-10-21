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

/** What `useWindowedRows` can be told besides the list itself. */
export interface WindowedOptions {
  /** Rows kept beyond each edge of the view. */
  overscan?: number;
  /** Lists with this many rows or fewer render whole (nothing to gain, and the markup stays as it was). */
  minRows?: number;
  /** The list runs left to right (the mixer's strips): the "rows" are columns, `rowHeight` their pitch in pixels. */
  horizontal?: boolean;
  /** Pixels of other content before the first row in the scrolling direction (the mixer's Master strip). */
  leading?: number;
}

/**
 * Windowing for a long list of equal-height rows inside the scrolling element `ref` points at: only the rows near the viewport are in
 * the DOM. Lists shorter than `minRows` render whole (nothing to gain, and the markup stays as it was).
 * The row height is fixed by the caller's CSS; the window re-computes on scroll, resize and when the count changes,
 * and re-renders only when the first or last row changes. With `horizontal` the list runs sideways and `rowHeight` is
 * the width of one column, gap included.
 */
export function useWindowedRows(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  { overscan = 8, minRows = 60, horizontal = false, leading = 0 }: WindowedOptions = {},
): Windowed {
  const [range, setRange] = useState({ first: 0, last: Math.min(count, minRows) });
  const whole = count <= minRows;

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scroll = (horizontal ? el.scrollLeft : el.scrollTop) - leading;
    const extent = horizontal ? el.clientWidth : el.clientHeight;
    const first = Math.max(0, Math.floor(scroll / rowHeight) - overscan);
    const last = Math.min(count, Math.ceil((scroll + extent) / rowHeight) + overscan);
    setRange((r) => (r.first === first && r.last === last ? r : { first, last }));
  }, [ref, count, rowHeight, overscan, horizontal, leading]);

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
