/**
 * Where a floating card goes next to what it is about (the tour's step card, the Ask AI card): beside
 * the target rect where there is room, kept on screen.
 */

export type Side = 'right' | 'left' | 'below' | 'above';

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The card's top-left corner for a card `w`×`h` next to rect `r` in a `vw`×`vh` viewport: the first
 * side in `order` with room, else inside the rect's bottom-right corner; centered without a rect.
 * Always at least 8 px inside the viewport.
 */
export function placeBeside(
  r: RectLike | null,
  w: number,
  h: number,
  vw: number,
  vh: number,
  order: readonly Side[] = ['right', 'left', 'below', 'above'],
  margin = 14,
): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (!r) return { x: (vw - w) / 2, y: (vh - h) / 2 };
  const at: Record<Side, { x: number; y: number; ok: boolean }> = {
    right: { x: r.right + margin, y: r.top, ok: r.right + margin + w <= vw - 8 },
    left: { x: r.left - margin - w, y: r.top, ok: r.left - margin - w >= 8 },
    below: { x: r.left, y: r.bottom + margin, ok: r.bottom + margin + h <= vh - 8 },
    above: { x: r.left, y: r.top - margin - h, ok: r.top - margin - h >= 8 },
  };
  const o = order.map((side) => at[side]).find((c) => c.ok) ?? { x: r.right - w - 24, y: r.bottom - h - 24 };
  return { x: clamp(o.x, 8, vw - w - 8), y: clamp(o.y, 8, vh - h - 8) };
}
