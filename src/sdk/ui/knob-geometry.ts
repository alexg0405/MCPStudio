// The drawing of a rotary knob: where its value arc and pointer go for a position 0-1.

/** Angle where the knob's travel starts, in degrees clockwise from straight up. */
const START_DEG = -135;
/** Degrees the knob turns from its minimum to its maximum. */
const SWEEP_DEG = 270;
/** The middle of the travel, where a bipolar arc starts. */
const MIDDLE_DEG = START_DEG + SWEEP_DEG / 2;

/** Stroke of the ring, as a share of the knob's size (rounded to half pixels, at least 2 px). */
const STROKE_SHARE = 0.075;
const MIN_STROKE = 2;
/** Gap between the ring and the stone body, px. */
const BODY_GAP = 2.25;
const MIN_BODY_RADIUS = 4;
/** The pointer starts this far from the centre (share of the body radius) and stops this many px short of the edge. */
const POINTER_START_SHARE = 0.3;
const POINTER_EDGE_INSET = 1.25;

/** The measurements of a knob of one size, in px. */
export interface KnobMetrics {
  center: number;
  /** Stroke width of the ring. */
  stroke: number;
  /** Radius of the ring. */
  radius: number;
  /** Radius of the stone body inside the ring. */
  bodyRadius: number;
}

/** The ring sits around a stone body; the pointer is drawn on the body. */
export function knobMetrics(size: number): KnobMetrics {
  const stroke = Math.max(MIN_STROKE, Math.round(size * STROKE_SHARE * 2) / 2);
  const radius = size / 2 - stroke / 2 - 0.5;
  const bodyRadius = Math.max(MIN_BODY_RADIUS, radius - stroke / 2 - BODY_GAP);
  return { center: size / 2, stroke, radius, bodyRadius };
}

/** A point on a circle: `deg` clockwise from straight up. */
function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** An SVG arc path between two angles (empty when they are the same). */
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (Math.abs(to - from) < 0.01) return '';
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} ${sweep} ${b.x} ${b.y}`;
}

/** The empty ring behind the value arc: the whole travel. */
export function trackPath(m: KnobMetrics): string {
  return arc(m.center, m.center, m.radius, START_DEG, START_DEG + SWEEP_DEG);
}

/** The value arc for a position 0-1: from the start, or from the middle when `bipolar`. */
export function valueArcPath(position: number, m: KnobMetrics, bipolar: boolean | undefined): string {
  const deg = START_DEG + position * SWEEP_DEG;
  if (bipolar) return arc(m.center, m.center, m.radius, Math.min(MIDDLE_DEG, deg), Math.max(MIDDLE_DEG, deg));
  return arc(m.center, m.center, m.radius, START_DEG, deg);
}

/** The pointer line's two ends for a position 0-1. */
export function pointerEnds(position: number, m: KnobMetrics) {
  const deg = START_DEG + position * SWEEP_DEG;
  const from = polar(m.center, m.center, m.bodyRadius * POINTER_START_SHARE, deg);
  const to = polar(m.center, m.center, m.bodyRadius - POINTER_EDGE_INSET, deg);
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
}
