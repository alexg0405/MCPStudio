// Plain geometry types shared by view state and UI code.

/** A width and a height, in pixels. */
export interface Size {
  w: number;
  h: number;
}

/** A rectangle: its top-left corner (x, y) and its width and height, in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
