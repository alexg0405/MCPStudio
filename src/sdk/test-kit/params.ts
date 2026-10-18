import { encode, type ParamSpecs, type ParamValue } from '../params';
import type { ParamBlock } from '../worklet/kernel';

/** Param values for a test: plain values, or functions of the frame (automation). */
export type TestParams<P extends ParamSpecs> = { [K in keyof P]?: ParamValue | ((frame: number) => number) };

/** A constant param block (enums as option index, bools as 0/1), the way the SDK's processor passes it. */
export function paramBlock<P extends ParamSpecs>(specs: P, values: TestParams<P> = {}): ParamBlock<P> {
  const out: Record<string, Float32Array> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const v = values[key as keyof P];
    out[key] = new Float32Array([typeof v === 'function' ? v(0) : encode(spec, v ?? spec.default)]);
  }
  return out as ParamBlock<P>;
}
