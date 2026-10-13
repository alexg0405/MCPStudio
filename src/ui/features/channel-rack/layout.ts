/** Step-button geometry shared by the step row and the graph editor under it. */
export const STEP_W = 17;
export const STEP_GAP = 2;
export const GROUP_GAP = 5;

/** Left edge of step `i` inside the step row (every 4 steps get a wider gap). */
export function stepX(i: number): number {
  return i * (STEP_W + STEP_GAP) + Math.floor(i / 4) * (GROUP_GAP - STEP_GAP);
}

/** Width of a step row with `count` steps. */
export function stepsWidth(count: number): number {
  return stepX(count - 1) + STEP_W;
}

/** The step under an x position in the row, or -1 between steps and outside. */
export function stepAtX(x: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const left = stepX(i);
    if (x < left - STEP_GAP) return -1;
    if (x < left + STEP_W + STEP_GAP) return i;
  }
  return -1;
}
