/**
 * Time-stretching without changing pitch: WSOLA (waveform-similarity overlap-add, Verhelst &
 * Roelands 1993). The output is built from Hann-windowed frames of the input, overlapped by half a
 * frame. Each frame is taken near where the stretch says it should come from, shifted by up to
 * ±tolerance to the spot that best continues the previous frame's waveform, so periodic sounds keep
 * their period (their pitch) and the frames join without phase cancellation.
 *
 * Transients (drum hits) are kept whole: plain WSOLA reads a hit into two overlapping frames at
 * slightly different times when slowing down (a flam, or a doubled click) and can skip it when
 * speeding up, and moves it by up to the tolerance. Around each detected attack the input is
 * played at its own speed instead (a run of frames that continue each other exactly, which
 * overlap-add back to the original samples), centred on the hit's stretched time, and the stretch
 * is made up in the gaps between hits (Grofit & Lavner 2008 describe the same idea). Hits closer
 * together than that allows keep the strongest ones.
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
  /** Keep attacks whole and on time (default true). */
  transients?: boolean;
}

/** An attack in the input: its frame and how strong it is. */
export interface Onset {
  at: number;
  strength: number;
}

/**
 * Attacks in a mono signal: frames where the energy of the next ~10 ms jumps by 9 dB or more over
 * the ~20 ms before, and is within 40 dB of the loudest moment. Cheap (energy per 128-frame hop).
 */
export function detectOnsets(mono: Float32Array, sampleRate: number): Onset[] {
  return detectOnsetsLazy(mono.length, (dst, from, n) => dst.set(mono.subarray(from, from + n)), sampleRate);
}

/** Fills `dst[0..n)` with the mono mix from frame `from` (zeros outside the signal). */
export type MonoReader = (dst: Float32Array, from: number, n: number) => void;

/** `detectOnsets` for a mix that isn't in memory as one array: the energies are read a hop at a time. */
export function detectOnsetsLazy(length: number, read: MonoReader, sampleRate: number): Onset[] {
  const hop = Math.max(32, Math.round(sampleRate / 375));
  const hops = Math.floor(length / hop);
  if (hops < 16) return [];
  const block = new Float32Array(Math.max(hop, 4096));
  const e = new Float64Array(hops);
  for (let k0 = 0; k0 < hops; ) {
    const k1 = Math.min(hops, k0 + Math.floor(block.length / hop));
    read(block, k0 * hop, (k1 - k0) * hop);
    for (let k = k0; k < k1; k++) {
      let s = 0;
      for (let i = (k - k0) * hop, end = i + hop; i < end; i++) {
        const v = block[i] as number;
        s += v * v;
      }
      e[k] = s / hop;
    }
    k0 = k1;
  }
  const PRE = 8;
  const POST = 4;
  let loud = 0;
  for (let k = 0; k + POST <= hops; k++) {
    let p = 0;
    for (let j = 0; j < POST; j++) p += e[k + j] as number;
    loud = Math.max(loud, p / POST);
  }
  const gate = loud * 1e-4;
  const onsets: Onset[] = [];
  let runBest: Onset | null = null;
  for (let k = PRE; k + POST <= hops; k++) {
    let pre = 0;
    for (let j = 1; j <= PRE; j++) pre += e[k - j] as number;
    pre /= PRE;
    let post = 0;
    for (let j = 0; j < POST; j++) post += e[k + j] as number;
    post /= POST;
    const rising = post > gate && post > 8 * pre + 1e-12;
    if (rising) {
      const strength = Math.sqrt(post) - Math.sqrt(pre);
      if (!runBest || strength > runBest.strength) runBest = { at: k * hop, strength };
    } else if (runBest) {
      onsets.push(runBest);
      runBest = null;
    }
  }
  if (runBest) onsets.push(runBest);
  // The start of the attack: the first sample of the jump's window that reaches 30 % of its peak.
  const win = new Float32Array((POST + 2) * hop + hop);
  return onsets.map((o) => {
    const a = Math.max(0, o.at - hop);
    const b = Math.min(length, o.at + (POST + 1) * hop);
    read(win, a, b - a);
    let peak = 0;
    for (let i = 0; i < b - a; i++) peak = Math.max(peak, Math.abs(win[i] as number));
    let at = a;
    while (at < b && Math.abs(win[at - a] as number) < 0.3 * peak) at++;
    return { at, strength: o.strength };
  });
}

interface Zone {
  /** Input frame of the attack; the zone keeps [c − pre, c + post] of the input at its own speed. */
  c: number;
  /** Output frame the attack lands on (c × scale). */
  oc: number;
}

/**
 * Chooses the attacks to keep whole: strongest first, as long as the stretch can still be made up
 * between neighbours (each gap stays at least a hop long and stretched by at most 2× more, or 2×
 * less, than the overall scale).
 */
function placeZones(onsets: readonly Onset[], scale: number, pre: number, post: number, hop: number, inLen: number, outLen: number): Zone[] {
  const accepted: Zone[] = [];
  const gapOk = (aIn: number, aOut: number, bIn: number, bOut: number) => {
    const gi = bIn - aIn;
    const go = bOut - aOut;
    if (gi < hop || go < hop) return false;
    const local = go / gi;
    return local <= scale * 2 && local >= scale / 2;
  };
  const sorted = [...onsets].sort((a, b) => b.strength - a.strength);
  for (const o of sorted) {
    const z: Zone = { c: o.at, oc: Math.round(o.at * scale) };
    // Neighbours among the accepted ones (kept sorted by position).
    let i = 0;
    while (i < accepted.length && (accepted[i] as Zone).c < z.c) i++;
    const prev = accepted[i - 1];
    const next = accepted[i];
    const before = prev ? gapOk(prev.c + post, prev.oc + post, z.c - pre, z.oc - pre) : gapOk(0, 0, z.c - pre, z.oc - pre);
    const after = next
      ? gapOk(z.c + post, z.oc + post, next.c - pre, next.oc - pre)
      : gapOk(z.c + post, z.oc + post, inLen, outLen);
    if (before && after) accepted.splice(i, 0, z);
  }
  return accepted;
}

/** Finished output: `chunk[c][0..n)` are the frames from `at` on (valid only during the call). */
export type StretchSink = (at: number, chunk: readonly Float32Array[], n: number) => void;

/**
 * Returns the channels `scale` times as long (scale > 1 slows down), same pitch. The output has
 * exactly round(length · scale) frames.
 */
export function timeStretch(channels: readonly Float32Array[], scale: number, opts: StretchOptions): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('timeStretch: the scale must be a positive number.');
  const outLen = Math.max(0, Math.round(inLen * scale));
  const outs = channels.map(() => new Float32Array(outLen));
  stretchStream(channels, scale, opts, (at, chunk, n) => outs.forEach((o, c) => o.set((chunk[c] as Float32Array).subarray(0, n), at)));
  return outs;
}

/**
 * `timeStretch` that hands the output over as it is finished (half a frame at a time, in order, each frame of the
 * output exactly once) instead of building it: the caller decides where it goes (16-bit PCM, `stretchToPcm16`), so a
 * long song never exists as floats twice. The input isn't copied either: the mono mix for the similarity search is
 * read from the channels a window at a time. Every value is the same as `timeStretch` made before.
 */
export function stretchStream(channels: readonly Float32Array[], scale: number, opts: StretchOptions, sink: StretchSink): void {
  const inLen = channels[0]?.length ?? 0;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('timeStretch: the scale must be a positive number.');
  const outLen = Math.max(0, Math.round(inLen * scale));
  if (inLen === 0 || outLen === 0) return;
  if (Math.abs(scale - 1) < 1e-9) {
    sink(0, channels.map((c) => c.subarray(0, outLen)), outLen);
    return;
  }
  const sr = opts.sampleRate;
  const half = Math.max(16, Math.round((((opts.frameMs ?? 40) / 1000) * sr) / 2));
  const N = half * 2;
  const Hs = half;
  const tol = Math.max(1, Math.round(((opts.toleranceMs ?? 12) / 1000) * sr));

  // Periodic Hann: frames half a frame apart sum to exactly 1.
  const win = new Float32Array(N);
  for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);

  // The mono mix for the similarity search is never held whole: `readMono` makes any window of it from the
  // channels (zeros outside the signal), accumulated channel by channel in float like an array of it would be.
  const nch = channels.length;
  const c0 = channels[0] as Float32Array;
  const c1 = channels[1] as Float32Array | undefined;
  const readMono: MonoReader = (dst, from, n) => {
    const lo = Math.max(0, -from);
    const hi = Math.min(n, inLen - from);
    if (lo > 0) dst.fill(0, 0, Math.min(n, lo));
    if (hi < n) dst.fill(0, Math.max(0, hi), n);
    if (nch === 1) {
      for (let j = lo; j < hi; j++) dst[j] = c0[from + j] as number;
    } else if (nch === 2) {
      const c1s = c1 as Float32Array;
      for (let j = lo; j < hi; j++) dst[j] = Math.fround(Math.fround((c0[from + j] as number) + (c1s[from + j] as number)) / 2);
    } else {
      for (let j = lo; j < hi; j++) {
        let m = 0;
        for (let c = 0; c < nch; c++) m = Math.fround(m + ((channels[c] as Float32Array)[from + j] as number));
        dst[j] = Math.fround(m / nch);
      }
    }
  };
  // Decimated (~6 kHz) copy for the coarse pass, over the signal padded on both sides as the fine search sees it.
  const PAD = N + 2 * tol + 64;
  const D = Math.max(1, Math.round(sr / 6000));
  const dPAD = Math.ceil(PAD / D);
  const dLen = Math.floor((inLen + 2 * PAD) / D);
  const deci = new Float32Array(dLen);
  {
    const J = 2048;
    const block = new Float32Array(J * D);
    for (let j0 = 0; j0 < dLen; j0 += J) {
      const jn = Math.min(J, dLen - j0);
      readMono(block, j0 * D - PAD, jn * D);
      for (let j = 0; j < jn; j++) {
        let sum = 0;
        for (let k = 0; k < D; k++) sum += block[j * D + k] as number;
        deci[j0 + j] = sum / D;
      }
    }
  }
  // Windows of the mix for the fine search: the target half frame, and the candidates' span.
  const tgtBuf = new Float32Array(Hs);
  const candBuf = new Float32Array(Hs + 2 * tol + 4);

  // The time map: output frame → input frame, slope 1/scale except around kept attacks (slope 1).
  const pre = N + Hs + tol;
  const post = Hs + tol;
  const zones =
    opts.transients === false
      ? []
      : placeZones(detectOnsetsLazy(inLen, readMono, sr), scale, pre, post, Hs, inLen, outLen);
  // Anchors (output, input), increasing in both.
  const ao: number[] = [0];
  const ai: number[] = [0];
  for (const z of zones) {
    ao.push(z.oc - pre, z.oc + post);
    ai.push(z.c - pre, z.c + post);
  }
  ao.push(outLen);
  ai.push(inLen);
  let seg = 0;
  const mapOut = (o: number) => {
    while (seg < ao.length - 2 && o >= (ao[seg + 1] as number)) seg++;
    const o0 = ao[seg] as number;
    const o1 = ao[seg + 1] as number;
    const i0 = ai[seg] as number;
    const i1 = ai[seg + 1] as number;
    return o1 > o0 ? i0 + ((o - o0) * (i1 - i0)) / (o1 - o0) : i0;
  };
  /** Index of the zone whose kept span contains output frame `o`, or −1. */
  let zi = 0;
  const zoneAt = (o: number) => {
    while (zi < zones.length && (zones[zi] as Zone).oc + post < o) zi++;
    const z = zones[zi];
    return z && o >= z.oc - pre ? zi : -1;
  };

  /** The best start in [nominal + lo, nominal + hi] to continue the input at `target` (both unpadded). */
  const search = (target: number, nominal: number, lo: number, hi: number): number => {
    // Coarse: normalized correlation on the decimated mix over the overlapping half frame.
    const len = Math.max(1, Math.floor(Hs / D));
    const t0 = Math.floor(target / D) + dPAD;
    const c0 = Math.floor((nominal + lo) / D) + dPAD;
    const c1 = Math.ceil((nominal + hi) / D) + dPAD;
    let yy = 1e-12;
    for (let i = 0; i < len; i++) yy += (deci[c0 + i] as number) ** 2;
    // Ties (silence) go to the candidate nearest the nominal position, so silence doesn't drift.
    const cn = Math.round(nominal / D) + dPAD;
    let best = c0;
    let bestScore = -Infinity;
    for (let c = c0; c <= c1; c++) {
      let xy = 0;
      for (let i = 0; i < len; i++) xy += (deci[t0 + i] as number) * (deci[c + i] as number);
      const score = xy / Math.sqrt(yy);
      if (score > bestScore || (score === bestScore && Math.abs(c - cn) < Math.abs(best - cn))) {
        bestScore = score;
        best = c;
      }
      // Slide the candidate's energy window by one.
      yy += (deci[c + len] as number) ** 2 - (deci[c] as number) ** 2;
      if (yy < 1e-12) yy = 1e-12;
    }
    const coarse = (best - dPAD) * D - nominal;
    // Fine: full rate around the coarse pick.
    const f0 = Math.max(lo, coarse - D);
    const f1 = Math.min(hi, coarse + D);
    readMono(tgtBuf, target, Hs);
    readMono(candBuf, nominal + f0, f1 - f0 + Hs + 1);
    let fy = 1e-12;
    for (let i = 0; i < Hs; i++) fy += (candBuf[i] as number) ** 2;
    let fine = f0;
    bestScore = -Infinity;
    for (let d = f0; d <= f1; d++) {
      const cp = d - f0;
      let xy = 0;
      for (let i = 0; i < Hs; i++) xy += (tgtBuf[i] as number) * (candBuf[cp + i] as number);
      const score = xy / Math.sqrt(fy);
      if (score > bestScore || (score === bestScore && Math.abs(d) < Math.abs(fine))) {
        bestScore = score;
        fine = d;
      }
      fy += (candBuf[cp + Hs] as number) ** 2 - (candBuf[cp] as number) ** 2;
      if (fy < 1e-12) fy = 1e-12;
    }
    return nominal + fine;
  };

  let prev = 0;
  let prevZone = -1;
  const frames = Math.ceil(outLen / Hs) + 1;
  // The frames that overlap the half frame being finished: `acc[0..N)` is the output from `o` on.
  const acc = channels.map(() => new Float32Array(N));
  for (let m = 0; m < frames; m++) {
    const o = m * Hs;
    const nominal = Math.round(mapOut(o));
    const zone = zoneAt(o);
    let start = nominal;
    if (m > 0) {
      if (zone >= 0 && zone === prevZone) {
        // Inside a kept attack: continue the previous frame exactly (the input at its own speed).
        start = prev + Hs;
      } else {
        // Entering a kept attack: only a small shift, so the hit lands on its stretched time.
        const t = zone >= 0 ? Math.max(1, Math.round(tol / 6)) : tol;
        const lo = Math.max(-nominal, -t);
        const hi = Math.min(t, inLen - 1 - nominal);
        if (hi >= lo) start = search(prev + Hs, nominal, lo, hi);
      }
    }
    prev = start;
    prevZone = zone;
    for (let ci = 0; ci < channels.length; ci++) {
      const x = channels[ci] as Float32Array;
      const y = acc[ci] as Float32Array;
      const nEnd = Math.min(N, outLen - o);
      // Nothing comes before the first frame: its first half goes in unwindowed.
      const n0 = m === 0 ? Hs : 0;
      if (m === 0) for (let n = 0; n < Math.min(Hs, nEnd); n++) y[n] = (y[n] as number) + (x[start + n] ?? 0);
      if (start >= 0 && start + N <= inLen) {
        for (let n = n0; n < nEnd; n++) y[n] = (y[n] as number) + (win[n] as number) * (x[start + n] as number);
      } else {
        for (let n = n0; n < nEnd; n++) {
          const i = start + n;
          if (i >= 0 && i < inLen) y[n] = (y[n] as number) + (win[n] as number) * (x[i] as number);
        }
      }
    }
    // The first half of the window is finished (the next frame only adds from `o + Hs` on).
    const done = Math.min(Hs, outLen - o);
    if (done > 0) sink(o, acc, done);
    for (const y of acc) {
      y.copyWithin(0, Hs, N);
      y.fill(0, Hs, N);
    }
  }
}
