// Grain fades: one lookup table per grain shape, made once when the module loads (never in the audio callback).

/** Table points per grain; a grain steps through them at its own speed so it ends exactly when its last point is reached. */
export const ENV_POINTS = 1024;
/** The last usable position in a table (reading at `e` also reads `e + 1`, so tables have two extra points). */
export const ENV_LAST = ENV_POINTS - 1;

/** Each shape as a function of t, the time through the grain from 0 to 1. Every shape is 0 at both ends, so no grain clicks. */
const SHAPES: readonly ((t: number) => number)[] = [
  // hann
  (t) => 0.5 - 0.5 * Math.cos(2 * Math.PI * t),
  // gauss: a bell, shifted so it reaches 0 at the ends
  (t) => {
    const edge = Math.exp(-0.5 * (0.5 / 0.17) ** 2);
    return (Math.exp(-0.5 * ((t - 0.5) / 0.17) ** 2) - edge) / (1 - edge);
  },
  // triangle
  (t) => 1 - Math.abs(2 * t - 1),
  // flat top: 15% ramps with a smooth start
  (t) => {
    const ramp = Math.min(1, t / 0.15, (1 - t) / 0.15);
    return ramp * ramp * (3 - 2 * ramp);
  },
  // pluck: 4% attack, then an exponential fall with a short fade at the very end
  (t) => (t < 0.04 ? t / 0.04 : Math.exp((-5 * (t - 0.04)) / 0.96)) * Math.min(1, (1 - t) / 0.02),
  // swell: a slow curved rise and a quick fall over the last 6%
  (t) => t * t * Math.min(1, (1 - t) / 0.06),
];

/** The tables, in the order of `GRAIN_SHAPES` in params.ts. */
export const SHAPE_TABLES: readonly Float32Array[] = SHAPES.map((shape) => {
  const table = new Float32Array(ENV_POINTS + 1);
  for (let i = 0; i < ENV_POINTS; i++) table[i] = shape(i / ENV_LAST);
  table[ENV_POINTS] = table[ENV_LAST] as number;
  return table;
});
