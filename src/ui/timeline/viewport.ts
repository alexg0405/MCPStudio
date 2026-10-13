/**
 * Shared coordinate system for timeline editors (piano roll now, playlist in M4):
 * x ↔ ticks (horizontal scroll + zoom) and y ↔ rows (vertical scroll, fixed row height).
 */
export class Viewport {
  /** Tick at the left edge. */
  scrollTick = 0;
  pxPerTick = 0.1;
  /** Row at the top edge (fractional). */
  scrollRow = 0;
  rowHeight = 14;
  /** Visible area in CSS pixels. */
  width = 0;
  height = 0;

  constructor(
    public rows: number,
    public minPxPerTick = 0.004,
    public maxPxPerTick = 2,
  ) {}

  tickToX(tick: number): number {
    return (tick - this.scrollTick) * this.pxPerTick;
  }

  xToTick(x: number): number {
    return this.scrollTick + x / this.pxPerTick;
  }

  rowToY(row: number): number {
    return (row - this.scrollRow) * this.rowHeight;
  }

  yToRow(y: number): number {
    return this.scrollRow + y / this.rowHeight;
  }

  /** First and last tick visible. */
  visibleTicks(): [number, number] {
    return [this.scrollTick, this.xToTick(this.width)];
  }

  /** First and last (inclusive) visible row indexes. */
  visibleRows(): [number, number] {
    return [Math.max(0, Math.floor(this.scrollRow)), Math.min(this.rows - 1, Math.ceil(this.yToRow(this.height)))];
  }

  scrollBy(dx: number, dy: number, maxTick: number): void {
    this.scrollTick = clamp(
      this.scrollTick + dx / this.pxPerTick,
      0,
      Math.max(0, maxTick - this.width / this.pxPerTick),
    );
    this.scrollRow = clamp(
      this.scrollRow + dy / this.rowHeight,
      0,
      Math.max(0, this.rows - this.height / this.rowHeight),
    );
  }

  /** Zooms horizontally keeping the tick under `anchorX` fixed. */
  zoomX(factor: number, anchorX: number): void {
    const anchorTick = this.xToTick(anchorX);
    this.pxPerTick = clamp(this.pxPerTick * factor, this.minPxPerTick, this.maxPxPerTick);
    this.scrollTick = Math.max(0, anchorTick - anchorX / this.pxPerTick);
  }

  /** Zooms vertically keeping the row under `anchorY` fixed. */
  zoomY(factor: number, anchorY: number, min = 6, max = 40): void {
    const anchorRow = this.yToRow(anchorY);
    this.rowHeight = clamp(this.rowHeight * factor, min, max);
    this.scrollRow = clamp(
      anchorRow - anchorY / this.rowHeight,
      0,
      Math.max(0, this.rows - this.height / this.rowHeight),
    );
  }

  clampScroll(maxTick: number): void {
    this.scrollBy(0, 0, maxTick);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
