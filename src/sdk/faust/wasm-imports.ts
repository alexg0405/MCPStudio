/** The imports a Faust-generated WebAssembly module asks for: the C math library, in float and double flavours. */

/** The math functions Faust's generated code calls, by their C names without the `_` prefix or `f` suffix. */
const MATH_FUNCTIONS: Record<string, (...x: number[]) => number> = {
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  fmod: (x, y) => x % y,
  log: Math.log,
  log10: Math.log10,
  remainder: (x, y) => x - Math.round(x / y) * y,
  pow: Math.pow,
  round: Math.round,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  acosh: Math.acosh,
  asinh: Math.asinh,
  atanh: Math.atanh,
  cosh: Math.cosh,
  sinh: Math.sinh,
  tanh: Math.tanh,
  isnan: (x) => (Number.isNaN(x) ? 1 : 0),
  isinf: (x) => (Number.isFinite(x) || Number.isNaN(x) ? 0 : 1),
  copysign: (x, y) => (Math.sign(x) === Math.sign(y) ? x : -x),
};

/**
 * What Faust's generated code may import. Each math function is offered under both its float name
 * (`_sinf`) and its double name (`_sin`); the memory and table fields are the legacy asm.js ones that
 * Faust's wasm output still lists.
 */
export function faustImports(): WebAssembly.Imports {
  const env: Record<string, unknown> = {
    memoryBase: 0,
    tableBase: 0,
    table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
  };
  for (const [name, fn] of Object.entries(MATH_FUNCTIONS)) {
    env[`_${name}f`] = fn;
    env[`_${name}`] = fn;
  }
  env._abs = Math.abs;
  env._max_f = env._max_ = Math.max;
  env._min_f = env._min_ = Math.min;
  return { env } as WebAssembly.Imports;
}
