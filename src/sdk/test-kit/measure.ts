/** Measuring what a kernel rendered. */

/** Root mean square of `x` over frames [from, to). */
export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(x.length, Math.floor(to));
  for (let i = a; i < b; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Largest absolute value of `x` over frames [from, to). */
export function peak(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i] as number));
  return m;
}
