/** Reading a number someone typed into a number field (DragNumber): plain, pure, unit-tested. */

/**
 * The number in `text`, or null when there is none: "140.5", " 140,5 " (a decimal comma), "+3", "-12",
 * ".5", "1e2". A unit after the number is ignored ("140 bpm", "-3 dB", "50%").
 */
export function parseTypedNumber(text: string): number | null {
  const m = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*[a-z%]*\s*$/i.exec(text);
  if (!m) return null;
  const v = Number((m[1] as string).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
