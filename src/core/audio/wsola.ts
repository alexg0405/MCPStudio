/**
 * Time-stretching without changing pitch: WSOLA (waveform-similarity overlap-add, Verhelst &
 * Roelands 1993). The output is built from Hann-windowed frames of the input, overlapped by half a
 * frame. Each frame is taken near where the stretch says it should come from, shifted by up to
 * ±tolerance to the spot that best continues the previous frame's waveform, so periodic sounds keep
 * their period (their pitch) and the frames join without phase cancellation.
 *
 * The similarity search runs on a decimated mono mix (coarse) and is refined at the full rate; every
 * channel uses the same frame positions, so the stereo image holds. Pure TypeScript (Worker or Node).
 */

export interface StretchOptions {
  sampleRate: number;
  /** Frame length (default 40 ms). */
  frameMs?: number;
  /** How far a frame may move to match the previous one (default 12 ms). */
  toleranceMs?: number;
}

/**
 * Returns the channels `scale` times as long (scale > 1 slows down), same pitch. The output has
 * exactly round(length · scale) frames.
 */
export function timeStretch(channels: readonly Float32Array[], scale: number, opts: StretchOptions): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('timeStretch: the scale must be a positive number.');
  const outLen = Math.max(0, Math.round(inLen * scale));
  const outs = channels.map(() => new Float32Array(outLen));
  if (inLen === 0 || outLen === 0) return outs;
  if (Math.abs(scale - 1) < 1e-9) {
    channels.forEach((c, i) => (outs[i] as Float32Array).set(c.subarray(0, outLen)));
    return outs;
  }
  const sr = opts.sampleRate;
  const half = Math.max(16, Math.round((((opts.frameMs ?? 40) / 1000) * sr) / 2));
  const N = half * 2;
  const Hs = half;
  const Ha = Hs / scale;
  const tol = Math.max(1, Math.round(((opts.toleranceMs ?? 12) / 1000) * sr));

  // Periodic Hann: frames half a frame apart sum to exactly 1.
  const win = new Float32Array(N);
  for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);

  // Mono mix for the similarity search, and a decimated copy for the coarse pass.
  const mono = new Float32Array(inLen);
  for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] = (mono[i] as number) + (c[i] as number);
  if (channels.length > 1) for (let i = 0; i < inLen; i++) mono[i] = (mono[i] as number) / channels.length;
  const D = Math.max(1, Math.round(sr / 12000));
  const dLen = Math.floor(inLen / D);
  const deci = new Float32Array(dLen);
  for (let j = 0; j < dLen; j++) {
    let s = 0;
    for (let k = 0; k < D; k++) s += mono[j * D + k] as number;
    deci[j] = s / D;
  }

  const at = (x: Float32Array, i: number) => (i >= 0 && i < x.length ? (x[i] as number) : 0);
  /** Normalized correlation of x[a…a+len) with x[b…b+len), step `step`. */
  const corr = (x: Float32Array, a: number, b: number, len: number): number => {
    let xy = 0;
    let yy = 1e-12;
    for (let i = 0; i < len; i++) {
      const u = at(x, a + i);
      const v = at(x, b + i);
      xy += u * v;
      yy += v * v;
    }
    return xy / Math.sqrt(yy);
  };

  let prev = 0;
  const frames = Math.ceil(outLen / Hs) + 1;
  for (let m = 0; m < frames; m++) {
    const nominal = Math.round(m * Ha);
    let start = nominal;
    if (m > 0) {
      // The waveform that would naturally follow the previous frame.
      const target = prev + Hs;
      const lo = Math.max(-nominal, -tol);
      const hi = Math.min(tol, inLen - 1 - nominal);
      if (hi >= lo) {
        // Coarse: on the decimated mix, over the overlapping half frame.
        const len = Math.max(1, Math.floor(Hs / D));
        let best = lo;
        let bestScore = -Infinity;
        for (let d = Math.floor(lo / D); d <= Math.ceil(hi / D); d++) {
          const score = corr(deci, Math.floor(target / D), Math.floor(nominal / D) + d, len);
          if (score > bestScore) {
            bestScore = score;
            best = d * D;
          }
        }
        // Fine: full rate around the coarse pick.
        let fine = best;
        bestScore = -Infinity;
        for (let d = Math.max(lo, best - D); d <= Math.min(hi, best + D); d++) {
          const score = corr(mono, target, nominal + d, Hs);
          if (score > bestScore) {
            bestScore = score;
            fine = d;
          }
        }
        start = nominal + fine;
      }
    }
    prev = start;
    const o = m * Hs;
    for (let ci = 0; ci < channels.length; ci++) {
      const x = channels[ci] as Float32Array;
      const y = outs[ci] as Float32Array;
      // Nothing comes before the first frame: its first half goes in unwindowed.
      for (let n = 0; n < N; n++) {
        const oi = o + n;
        if (oi >= outLen) break;
        const w = m === 0 && n < Hs ? 1 : (win[n] as number);
        y[oi] = (y[oi] as number) + w * at(x, start + n);
      }
    }
  }
  return outs;
}
