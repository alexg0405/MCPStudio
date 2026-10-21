/**
 * The shapes a score is drawn with, as SVG paths in "staff space" units (1 unit = the gap between two staff lines), so no
 * music font is needed. Each function returns a path element string to place with `place()`, which moves and scales it.
 * Strokes and fills use `currentColor`, so the page's theme colours them.
 */

/** Rounds a number for the SVG text (two decimals): the same score always gives the same text. */
export const num = (value: number): string => String(Math.round(value * 100) / 100);

/** Wraps shapes in a group at (x, y) scaled to `space` pixels per staff space. */
export function place(x: number, y: number, space: number, shapes: string, extra = ''): string {
  return `<g transform="translate(${num(x)} ${num(y)}) scale(${num(space)})"${extra}>${shapes}</g>`;
}

const fill = (d: string, extra = ''): string => `<path d="${d}" fill="currentColor"${extra}/>`;
const stroke = (d: string, width: number, extra = ''): string =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;

/** A full ellipse as a path, turned by `degrees` (a notehead leans up to the right). */
function ellipsePath(rx: number, ry: number, degrees: number): string {
  const turn = (degrees * Math.PI) / 180;
  const dx = rx * Math.cos(turn);
  const dy = -rx * Math.sin(turn);
  return `M${num(-dx)} ${num(-dy)}A${num(rx)} ${num(ry)} ${num(-degrees)} 1 1 ${num(dx)} ${num(dy)}A${num(rx)} ${num(ry)} ${num(-degrees)} 1 1 ${num(-dx)} ${num(-dy)}Z`;
}

/** Notehead half-width in staff spaces (the layout leaves room for it). */
export const HEAD_HALF_WIDTH = 0.65;

/** A notehead: filled (quarter and shorter), hollow (half) or a whole-note ring; `x` and `diamond` for percussion. */
export function notehead(kind: 'filled' | 'half' | 'whole' | 'x' | 'diamond', extra = ''): string {
  switch (kind) {
    case 'filled':
      return fill(ellipsePath(0.66, 0.46, 22), extra);
    case 'half':
      return fill(`${ellipsePath(0.66, 0.46, 22)}${ellipsePath(0.5, 0.2, 52)}`, ` fill-rule="evenodd"${extra}`);
    case 'whole':
      return fill(`${ellipsePath(0.95, 0.5, 0)}${ellipsePath(0.42, 0.29, 60)}`, ` fill-rule="evenodd"${extra}`);
    case 'x':
      return stroke('M-0.55-0.45L0.55 0.45M0.55-0.45L-0.55 0.45', 0.28, extra);
    case 'diamond':
      return fill('M0-0.5L0.72 0L0 0.5L-0.72 0Z', extra);
  }
}

/** The small open-hi-hat circle drawn above a cross head. */
export function openMark(): string {
  return stroke('M-0.3 0A0.3 0.3 0 1 1 0.3 0A0.3 0.3 0 1 1 -0.3 0Z', 0.12);
}

/** A dot after a note. */
export function dot(): string {
  return fill('M-0.22 0A0.22 0.22 0 1 1 0.22 0A0.22 0.22 0 1 1 -0.22 0Z');
}

/** A sharp, flat, natural, double sharp or double flat, centred on the note's line or space. */
export function accidental(kind: 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'double-flat'): string {
  switch (kind) {
    case 'sharp':
      return `${stroke('M-0.2-1.15V1.3M0.2-1.3V1.15', 0.1)}${stroke('M-0.5 0.4L0.5 0.1M-0.5-0.25L0.5-0.55', 0.3)}`;
    case 'flat':
      return flatShape(0);
    case 'natural':
      return `${stroke('M-0.28-1.25V0.55M0.28-0.55V1.25', 0.1)}${stroke('M-0.28 0.4L0.28 0.2M-0.28-0.25L0.28-0.45', 0.24)}`;
    case 'double-sharp':
      return stroke('M-0.42-0.42L0.42 0.42M0.42-0.42L-0.42 0.42', 0.3);
    case 'double-flat':
      return `${flatShape(-0.4)}${flatShape(0.35)}`;
  }
}

function flatShape(shift: number): string {
  const move = (x: number): string => num(x + shift);
  return stroke(`M${move(-0.2)}-1.75V0.5C${move(0.5)} 0.15 ${move(0.7)}-0.45 ${move(0.4)}-0.7C${move(0.15)}-0.9 ${move(-0.1)}-0.75 ${move(-0.2)}-0.35`, 0.17);
}

/** A flag at the tip of a stem pointing up (at the origin, hanging to the right and down); `isDown` mirrors it for stems down. */
export function flag(isDown: boolean): string {
  const shape = fill('M0 0C0.1 0.8 1.15 1.2 0.95 2.5C0.85 1.75 0.35 1.55 0 1.5Z');
  return isDown ? `<g transform="scale(1 -1)">${shape}</g>` : shape;
}

/** Rests, centred on x = 0 and measured from the staff line they sit on or hang from (y = 0). */
export function restShape(base: number): string {
  switch (base) {
    case 1:
      return fill('M-0.6 0H0.6V0.5H-0.6Z');
    case 2:
      return fill('M-0.6-0.5H0.6V0H-0.6Z');
    case 4:
      return stroke('M0.2-1.5L-0.3-0.65L0.3 0.05L-0.25 0.8M-0.25 0.8C0.35 0.5 0.55 1 0 1.55', 0.3);
    default:
      return flagRest(Math.log2(base) - 2);
  }
}

/** An eighth rest or shorter: a dot and a hook for each flag on a slanted stem, around the middle line. */
function flagRest(flags: number): string {
  const parts: string[] = [];
  const top = -0.75 - (flags - 1) * 0.5;
  for (let i = 0; i < flags; i++) {
    const y = top + i;
    const x = -0.25 + i * 0.12;
    parts.push(fill(`M${num(x - 0.25)} ${num(y)}A0.25 0.25 0 1 1 ${num(x + 0.25)} ${num(y)}A0.25 0.25 0 1 1 ${num(x - 0.25)} ${num(y)}Z`));
    parts.push(stroke(`M${num(x + 0.2)} ${num(y + 0.1)}C${num(x + 0.55)} ${num(y + 0.1)} ${num(x + 0.7)} ${num(y - 0.1)} ${num(x + 0.78)} ${num(y - 0.35)}`, 0.14));
  }
  const bottom = top + flags;
  parts.push(stroke(`M${num(0.55 + (flags - 1) * 0.12)} ${num(top - 0.2)}L${num(-0.1 + (flags - 1) * 0.12 - 0.1)} ${num(bottom + 0.55)}`, 0.14));
  return parts.join('');
}

/** The treble clef, origin on the G line (the second line from the bottom). */
export function trebleClef(): string {
  return stroke(
    'M-0.25 2.35C-0.25 3.1 0.6 3.15 0.65 2.45C0.7 1.85 0 1.7-0.1 0.95C-0.25-0.2 0.95-0.95 1-2.1C1.05-3.2 0.45-3.95 0.05-3.95C-0.45-3.95-0.6-3-0.3-1.55C-0.05-0.35 0.3 1.1 0.5 2.1',
    0.28,
  ) +
    stroke('M0.45 0.95C1.5 0.9 1.55-0.7 0.4-0.85C-0.85-1.05-1.3 0.55-0.55 1.15C-0.05 1.55 0.75 1.2 0.7 0.5', 0.24);
}

/** The bass clef, origin on the F line (the second line from the top). */
export function bassClef(): string {
  return (
    fill('M-1.15-0.2A0.6 0.55 0 1 1 0.05-0.25A0.6 0.55 0 1 1 -1.15-0.2Z') +
    stroke('M-1.1-0.1C-0.4-0.9 1.2-0.7 1.1 0.5C1.0 1.5 0.1 2.2-1.2 2.7', 0.3) +
    fill('M1.55-0.5A0.2 0.2 0 1 1 1.95-0.5A0.2 0.2 0 1 1 1.55-0.5ZM1.55 0.5A0.2 0.2 0 1 1 1.95 0.5A0.2 0.2 0 1 1 1.55 0.5Z')
  );
}

/** The percussion clef: two short thick bars, centred on the middle line of the staff. */
export function percussionClef(): string {
  return fill('M-0.55-0.9H-0.2V0.9H-0.55ZM0.2-0.9H0.55V0.9H0.2Z');
}

/** A brace joining the two staves of a piano part: from (0, 0) at the top to (0, height) at the bottom, in the same units. */
export function brace(height: number): string {
  const mid = height / 2;
  return fill(
    `M0.9 0C-0.15 ${num(height * 0.12)} 0.9 ${num(mid - 0.6)} -0.3 ${num(mid)}C0.9 ${num(mid + 0.6)} -0.15 ${num(height * 0.88)} 0.9 ${num(height)}C0.2 ${num(height * 0.88)} 0.1 ${num(mid + 1)} 0.1 ${num(mid)}C0.1 ${num(mid - 1)} 0.2 ${num(height * 0.12)} 0.9 0Z`,
  );
}
