/**
 * Small IIR helpers for voice analysis: Butterworth high/low-pass cascades (RBJ biquads) and
 * integer-factor decimation. Internal to `core/voice` (core can't import the SDK's DSP).
 */

/** Q of each biquad in an even-order Butterworth cascade. */
function butterworthQs(order: 2 | 4 | 8): number[] {
  const qs: number[] = [];
  for (let k = 0; k < order / 2; k++) qs.push(1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order))));
  return qs;
}

/** Normalized biquad coefficients [b0, b1, b2, a1, a2] (RBJ cookbook). */
function biquad(type: 'lowpass' | 'highpass', freq: number, q: number, sampleRate: number): number[] {
  const f = Math.min(Math.max(freq, 1e-3), sampleRate * 0.49);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = type === 'lowpass' ? b1 / 2 : -b1 / 2;
  return [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/** Coefficients of a Butterworth cascade, five numbers per section. */
export function butterworth(
  type: 'lowpass' | 'highpass',
  order: 2 | 4 | 8,
  freq: number,
  sampleRate: number,
): Float64Array {
  return Float64Array.from(butterworthQs(order).flatMap((q) => biquad(type, freq, q, sampleRate)));
}

/** Runs a cascade (from `butterworth`) over `x` in place, from zero state. */
export function filterInPlace(x: Float32Array, sections: Float64Array): void {
  for (let s = 0; s + 4 < sections.length; s += 5) {
    const b0 = sections[s] as number;
    const b1 = sections[s + 1] as number;
    const b2 = sections[s + 2] as number;
    const a1 = sections[s + 3] as number;
    const a2 = sections[s + 4] as number;
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i] as number;
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      // Flush denormals (long digital silence after a sound).
      if (z1 < 1e-30 && z1 > -1e-30) z1 = 0;
      if (z2 < 1e-30 && z2 > -1e-30) z2 = 0;
      x[i] = y;
    }
  }
}

/**
 * Low-passes `x` (8th-order Butterworth at 0.4 × the new rate) and keeps every `factor`-th sample,
 * in one pass without a full-rate copy. Output length: ceil(x.length / factor).
 */
export function decimate(x: Float32Array, factor: number, sampleRate: number): Float32Array {
  const k = Math.max(1, Math.floor(factor));
  if (k === 1) return Float32Array.from(x);
  const out = new Float32Array(Math.ceil(x.length / k));
  const c = butterworth('lowpass', 8, (0.4 * sampleRate) / k, sampleRate);
  // Four sections, state in locals.
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0,
    s5 = 0,
    s6 = 0,
    s7 = 0;
  type Section = [number, number, number, number, number];
  const section = (s: number) => Array.from(c.subarray(5 * s, 5 * s + 5)) as Section;
  const [a0, a1, a2, a3, a4] = section(0);
  const [b0, b1, b2, b3, b4] = section(1);
  const [d0, d1, d2, d3, d4] = section(2);
  const [e0, e1, e2, e3, e4] = section(3);
  let phase = 0;
  let o = 0;
  for (let i = 0; i < x.length; i++) {
    let v = x[i] as number;
    let y = a0 * v + s0;
    s0 = a1 * v - a3 * y + s1;
    s1 = a2 * v - a4 * y;
    v = y;
    y = b0 * v + s2;
    s2 = b1 * v - b3 * y + s3;
    s3 = b2 * v - b4 * y;
    v = y;
    y = d0 * v + s4;
    s4 = d1 * v - d3 * y + s5;
    s5 = d2 * v - d4 * y;
    v = y;
    y = e0 * v + s6;
    s6 = e1 * v - e3 * y + s7;
    s7 = e2 * v - e4 * y;
    if (phase === 0) {
      out[o++] = y;
      // Flush denormals once per output sample; the state decays slowly enough for that.
      if (Math.abs(s0) < 1e-30) s0 = 0;
      if (Math.abs(s1) < 1e-30) s1 = 0;
      if (Math.abs(s2) < 1e-30) s2 = 0;
      if (Math.abs(s3) < 1e-30) s3 = 0;
      if (Math.abs(s4) < 1e-30) s4 = 0;
      if (Math.abs(s5) < 1e-30) s5 = 0;
      if (Math.abs(s6) < 1e-30) s6 = 0;
      if (Math.abs(s7) < 1e-30) s7 = 0;
    }
    if (++phase === k) phase = 0;
  }
  return out;
}
