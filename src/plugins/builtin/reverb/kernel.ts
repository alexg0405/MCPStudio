import { EffectKernel, flush, type ParamBlock } from '@agstudio/sdk/worklet';
import type { reverbParams } from './params';

type P = typeof reverbParams;

/** Delay lines in the feedback network. */
const N = 8;
/** Line lengths at Size 100 %, ms: spread over about 1.7 octaves, no two in a simple ratio. */
const LINE_MS = [29.3, 34.1, 41.3, 47.9, 56.3, 66.7, 79.1, 93.7] as const;
const LONGEST_MS = 93.7;
/** Size 0 % scales the lines by this (a small room). */
const MIN_SCALE = 0.45;
/** Lines whose length drifts slowly (breaks up metallic ringing), their rates (Hz) and depth (ms). */
const MOD_LINES = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const MOD_RATES = [0.31, 0.83, 0.47, 1.07, 0.59, 0.37, 0.97, 0.71] as const;
const MOD_MS = 0.5;
/** An allpass inside each line's loop (ms, gain): many more echoes and modes for the same lines. */
const LOOP_AP_MS = [7.3, 5.9, 9.1, 4.7, 8.3, 6.7, 3.9, 10.3] as const;
const LOOP_G = 0.5;
/** Input diffusion: four Schroeder allpasses a side (lengths in ms, L then R) and their gains. */
const DIFFUSER_MS = [4.77, 3.59, 12.73, 9.3, 4.31, 3.97, 11.83, 10.13] as const;
const DIFFUSER_G = [0.75, 0.75, 0.625, 0.625] as const;
/** Longest pre-delay (the param's max), seconds. */
const MAX_PRE_DELAY = 0.2;
/** Line lengths, modulation and coefficients are updated every CONTROL frames (delays ramp in between). */
const CONTROL = 32;
/** Smoothing time constants of Decay/Damping and of Size, seconds. */
const SMOOTH = 0.05;
const SIZE_SMOOTH = 0.1;
/** Fastest a line's length may glide, frames per frame (a Size change bends the tail's pitch, never clicks). */
const MAX_STEP = 0.25;
/** Lines gliding faster than this (frames per frame) read with linear interpolation. */
const GLIDE = 0.01;
/**
 * Three decay bands, like the convolution engine's impulse response, set by two first-order shelves
 * per line: the lows (below LOW_HZ) ring LOW_RATIO times longer than Decay, the highs (above
 * HIGH_HZ) die in Decay · (1 − HIGH_DAMP · Damping) and start at HIGH_LEVEL · (1 − 0.5 · Damping).
 * Tuned so each band's energy lands within about 2 dB of the convolution engine's at every Damping
 * (the shelves compound on every trip round, so the values differ from the IR generator's).
 */
const LOW_HZ = 250;
const HIGH_HZ = 8000;
const LOW_RATIO = 1.2;
const HIGH_DAMP = 0.6;
const HIGH_LEVEL = 0.85;
/** Frequencies sampled to estimate the tail's energy (for a loudness that doesn't depend on Decay). */
const ENERGY_POINTS = 24;
/** Input below this (about −120 dBFS) is silence; a tail below TAIL_FLOOR (−100 dBFS) is over. */
const SILENT = 1e-6;
const TAIL_FLOOR = 1e-5;
/** Seconds of silence in and below-floor tail out before the network is cleared and goes idle. */
const GATE_SECONDS = 0.5;
const LN_1000 = Math.log(1000);
const HALF_PI = Math.PI / 2;

const pow2Above = (n: number) => {
  let size = 4;
  while (size < n) size <<= 1;
  return size;
};

/**
 * Algorithmic stereo reverb: pre-delay → four allpass diffusers a side → an 8-line feedback delay
 * network mixed by a (fast Walsh–) Hadamard matrix. Each line has a one-pole low-pass (damping) and
 * a gain that makes it lose 60 dB in Decay seconds for its own length (Jot), so the RT60 holds at
 * any Size. Four lines drift slowly in length against ringing. Left and right are two orthogonal
 * sums of the lines (decorrelated); the wet level is normalized by the tail's energy so Decay
 * changes the length, not the loudness. Cost doesn't depend on Decay; all buffers are sized at
 * construction for the largest Size and pre-delay.
 */
export class ReverbKernel extends EffectKernel<P> {
  private readonly sr = this.sampleRate;
  // Delay lines: one buffer, N lines of `lineSize` frames, one shared write position.
  private readonly lineSize = pow2Above(Math.ceil(((LONGEST_MS + 2 * MOD_MS) / 1000) * this.sr) + 8);
  private readonly lineMask = this.lineSize - 1;
  private readonly lines = new Float32Array(N * this.lineSize);
  private lineW = 0;
  // Pre-delay: two channels.
  private readonly preSize = pow2Above(Math.ceil(MAX_PRE_DELAY * this.sr) + 4);
  private readonly preMask = this.preSize - 1;
  private readonly pre = new Float32Array(2 * this.preSize);
  private preW = 0;
  // Diffusers: 8 allpasses (4 a side), each a ring of exactly its length read and written at `diffAt`.
  private readonly diff = DIFFUSER_MS.map((ms) => new Float32Array(Math.max(1, Math.round((ms / 1000) * this.sr))));
  private readonly diffAt = new Int32Array(8);
  // The lines' own allpasses, rings like the diffusers'.
  private readonly loop = LOOP_AP_MS.map((ms) => new Float32Array(Math.max(1, Math.round((ms / 1000) * this.sr))));
  private readonly loopAt = new Int32Array(N);

  /** Current delay of each line (frames, fractional) and its per-frame step toward the next target. */
  private readonly delay = new Float64Array(N);
  private readonly step = new Float64Array(N);
  private readonly goal = new Float64Array(N);
  /** Each line's delay split for the allpass interpolation: whole frames and the allpass coefficient. */
  private readonly whole = new Int32Array(N);
  private readonly coef = new Float64Array(N);
  /** Length of each line without modulation (frames), for the coefficients. */
  private readonly nominal = new Float64Array(N);
  /** Each line's feedback gain, the value it ramps to by the next control update, and its step. */
  private readonly gain = new Float64Array(N);
  private readonly gainTo = new Float64Array(N);
  private readonly gainStep = new Float64Array(N);
  /**
   * Each line's two first-order shelves (transposed direct form II, one state each): a low shelf
   * (lows decay slower) and a high shelf (Damping), as [low b0, low b1, high b0, high b1].
   */
  private readonly shelf = new Float64Array(4 * N + 2);
  private readonly zLow = new Float64Array(N);
  private readonly zHigh = new Float64Array(N);
  /** The input's high shelf (the highs start quieter), its coefficients and its L/R states. */
  private inB0 = 1;
  private inB1 = 0;
  private readonly zIn = new Float64Array(2);
  /** Each line's fractional-delay allpass state (its last output). */
  private readonly ap = new Float64Array(N);
  private readonly phase = new Float64Array(MOD_LINES.length);
  /** Bilinear-transform corner frequencies of the shelves, and their (shared) feedback coefficients. */
  private readonly omegaLow = Math.tan((Math.PI * Math.min(LOW_HZ, 0.2 * this.sr)) / this.sr);
  private readonly omegaHigh = Math.tan((Math.PI * Math.min(HIGH_HZ, 0.4 * this.sr)) / this.sr);
  private readonly aLow = (this.omegaLow - 1) / (this.omegaLow + 1);
  private readonly aHigh = (this.omegaHigh - 1) / (this.omegaHigh + 1);
  // Frequencies for the energy estimate: dense at the lows (ω = π·u², u evenly spaced), where the
  // longest-ringing part of the tail is, with the matching weights.
  private readonly cosW = Float64Array.from({ length: ENERGY_POINTS }, (_, k) =>
    Math.cos(Math.PI * ((k + 0.5) / ENERGY_POINTS) ** 2),
  );
  private readonly weightW = Float64Array.from({ length: ENERGY_POINTS }, (_, k) => (2 * (k + 0.5)) / ENERGY_POINTS);
  private readonly modDepth = (MOD_MS / 1000) * this.sr;
  private readonly kSmooth = 1 - Math.exp(-CONTROL / (SMOOTH * this.sr));
  private readonly kSize = 1 - Math.exp(-CONTROL / (SIZE_SMOOTH * this.sr));
  private readonly gateFrames = Math.round(GATE_SECONDS * this.sr);

  /** Smoothed Decay (s), Damping and Size (0–1), and the values they glide to. */
  private decay = 2.2;
  private damping = 0.5;
  private size = 0.6;
  private decayTo = 2.2;
  private dampingTo = 0.5;
  private sizeTo = 0.6;
  /** Coefficients need recomputing (a smoothed value is still moving). */
  private settling = true;
  /** The next block snaps to its params instead of gliding (first block, after a reset). */
  private fresh = true;
  /**
   * Level of the sound fed into the network (ramped like the gains): it sets the tail's energy, so a
   * Decay change alters the length of new tails, not the level of the one ringing.
   */
  private inScale = 1;
  private inScaleTo = 1;
  private inScaleStep = 0;
  private countdown = 0;
  /** Mix → dry/wet gains (cached: recomputed only when the mix changes). */
  private mixFor = -1;
  private dryGain = 1;
  private wetGain = 0;
  /** Frames of silence in and a finished tail out; at gateFrames the network is cleared and idles. */
  private quiet = 0;
  private idle = true;
  /** This block's input and wet peaks (|L| + |R|), for the idle gate. */
  private peakIn = 0;
  private peakWet = 0;
  /** Scratch for one chunk: what each side feeds the network, and each line's output. */
  private readonly sendL = new Float64Array(CONTROL);
  private readonly sendR = new Float64Array(CONTROL);
  private readonly Y = new Float64Array(N * CONTROL);

  override reset(): void {
    this.clear();
    this.phase.fill(0);
    this.fresh = true;
    this.idle = true;
    this.quiet = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? input[0]) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? output[0]) as Float32Array;
    if (p.mix.length === 1) this.setMix(p.mix[0] as number);

    // Idle (nothing in the network): stay idle while silence comes in.
    if (this.idle) {
      let peakIn = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(inL[i] as number) + Math.abs(inR[i] as number);
        if (a > peakIn) peakIn = a;
      }
      if (peakIn < SILENT) {
        for (let i = 0; i < n; i++) {
          if (p.mix.length > 1) this.setMix(p.mix[i] as number);
          outL[i] = this.dryGain * (inL[i] as number);
          outR[i] = this.dryGain * (inR[i] as number);
        }
        return;
      }
      this.idle = false;
      this.quiet = 0;
    }

    this.targets(p.decay[0] as number, p.damping[0] as number, p.size[0] as number);
    this.peakIn = 0;
    this.peakWet = 0;
    let i = 0;
    while (i < n) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.control();
      }
      const m = Math.min(n - i, this.countdown);
      this.countdown -= m;
      this.chunk(inL, inR, outL, outR, i, m, p);
      i += m;
    }
    // Flush denormals and NaN out of the filter states.
    const zIn = this.zIn;
    for (let c = 0; c < 2; c++) zIn[c] = flush(zIn[c] as number);
    for (let k = 0; k < N; k++) {
      this.zLow[k] = flush(this.zLow[k] as number);
      this.zHigh[k] = flush(this.zHigh[k] as number);
      this.ap[k] = flush(this.ap[k] as number);
    }

    // Silence in and a tail under −100 dBFS for a while: clear the network and idle.
    if (this.peakIn < SILENT && this.peakWet < TAIL_FLOOR) {
      this.quiet += n;
      if (this.quiet >= this.gateFrames) {
        this.clear();
        this.idle = true;
        // With nothing in the network, the next sound starts at the current settings (no glide).
        this.fresh = true;
      }
    } else this.quiet = 0;
  }

  /**
   * `m` frames (at most CONTROL, so fewer than the shortest line: every read in the chunk sees
   * frames written before it) from frame `from`, stage by stage over the whole chunk.
   */
  private chunk(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    m: number,
    p: ParamBlock<P>,
  ): void {
    const sL = this.sendL;
    const sR = this.sendR;

    // 1. Pre-delay (linear interpolation: smooth when automated) and the input's high shelf.
    const pre = this.pre;
    const preMask = this.preMask;
    const preSize = this.preSize;
    const preConst = p.preDelay.length === 1;
    let preFrames = this.preFrames(p.preDelay[preConst ? 0 : from] as number);
    let preW = this.preW;
    const inB0 = this.inB0;
    const inB1 = this.inB1;
    const aHigh = this.aHigh;
    let zl = this.zIn[0] as number;
    let zr = this.zIn[1] as number;
    let peakIn = this.peakIn;
    for (let j = 0; j < m; j++) {
      const xl = inL[from + j] as number;
      const xr = inR[from + j] as number;
      const ax = Math.abs(xl) + Math.abs(xr);
      if (ax > peakIn) peakIn = ax;
      preW = (preW + 1) & preMask;
      pre[preW] = xl;
      pre[preSize + preW] = xr;
      if (!preConst) preFrames = this.preFrames(p.preDelay[from + j] as number);
      const pk = preFrames | 0;
      const pf = preFrames - pk;
      const pa = (preW - pk) & preMask;
      const pb = (preW - pk - 1) & preMask;
      const l0 = pre[pa] as number;
      const r0 = pre[preSize + pa] as number;
      const l = l0 + ((pre[pb] as number) - l0) * pf;
      const r = r0 + ((pre[preSize + pb] as number) - r0) * pf;
      const yl = inB0 * l + zl;
      zl = inB1 * l - aHigh * yl;
      const yr = inB0 * r + zr;
      zr = inB1 * r - aHigh * yr;
      sL[j] = yl;
      sR[j] = yr;
    }
    this.preW = preW;
    this.zIn[0] = zl;
    this.zIn[1] = zr;
    this.peakIn = peakIn;

    // 2. Input diffusion, four allpasses a side: v = x − g·w, y = w + g·v (w: the delayed state).
    for (let d = 0; d < 8; d++) {
      const buf = this.diff[d] as Float32Array;
      const len = buf.length;
      const g = DIFFUSER_G[d & 3] as number;
      const s = d < 4 ? sL : sR;
      let at = this.diffAt[d] as number;
      for (let j = 0; j < m; j++) {
        const w = buf[at] as number;
        const v = (s[j] as number) - g * w;
        buf[at] = v;
        s[j] = w + g * v;
        if (++at === len) at = 0;
      }
      this.diffAt[d] = at;
    }

    // 3. The level fed into the network.
    let scale = this.inScale;
    const scaleStep = this.inScaleStep;
    for (let j = 0; j < m; j++) {
      scale += scaleStep;
      sL[j] = (sL[j] as number) * scale;
      sR[j] = (sR[j] as number) * scale;
    }
    this.inScale = scale;

    // 4. Each line: read `delay` frames back, two shelves (the decay bands), its own allpass, its
    // gain. Fractional delays are allpass-interpolated (flat: no highs lost however often the tail
    // goes round), except while a line glides fast after a Size change: the allpass's switching
    // whole part would chirp there, and linear interpolation's slight dulling lasts only as long as
    // the glide.
    const lines = this.lines;
    const lineMask = this.lineMask;
    const base0 = this.lineW + 1;
    const Y = this.Y;
    const aLow = this.aLow;
    const shelf = this.shelf;
    for (let k = 0; k < N; k++) {
      const off = k * this.lineSize;
      const y0 = k * CONTROL;
      const st = this.step[k] as number;
      const lin = st > GLIDE || st < -GLIDE;
      let d = this.delay[k] as number;
      let w = this.whole[k] as number;
      let e = this.coef[k] as number;
      let a = this.ap[k] as number;
      let z1 = this.zLow[k] as number;
      let z2 = this.zHigh[k] as number;
      let g = this.gain[k] as number;
      const gs = this.gainStep[k] as number;
      const lb0 = shelf[4 * k] as number;
      const lb1 = shelf[4 * k + 1] as number;
      const hb0 = shelf[4 * k + 2] as number;
      const hb1 = shelf[4 * k + 3] as number;
      const ring = this.loop[k] as Float32Array;
      const len = ring.length;
      let at = this.loopAt[k] as number;
      for (let j = 0; j < m; j++) {
        const base = base0 + j;
        if (st !== 0) {
          d += st;
          w = (d - 0.5) | 0;
          const f = d - w;
          e = (1 - f) / (1 + f);
        }
        if (lin) {
          const wl = d | 0;
          const x0 = lines[off + ((base - wl) & lineMask)] as number;
          a = x0 + ((lines[off + ((base - wl - 1) & lineMask)] as number) - x0) * (d - wl);
        } else {
          const x0 = lines[off + ((base - w) & lineMask)] as number;
          a = e * (x0 - a) + (lines[off + ((base - w - 1) & lineMask)] as number);
        }
        const u = lb0 * a + z1;
        z1 = lb1 * a - aLow * u;
        let v = hb0 * u + z2;
        z2 = hb1 * u - aHigh * v;
        const t = ring[at] as number;
        v -= LOOP_G * t;
        ring[at] = v;
        v = t + LOOP_G * v;
        if (++at === len) at = 0;
        g += gs;
        Y[y0 + j] = g * v;
      }
      this.delay[k] = d;
      this.whole[k] = w;
      this.coef[k] = e;
      this.ap[k] = a;
      this.zLow[k] = z1;
      this.zHigh[k] = z2;
      this.gain[k] = g;
      this.loopAt[k] = at;
    }

    // 5. Mix the lines with a fast Walsh–Hadamard transform (orthogonal after the 1/√8) and write
    // them back with the input: left into the even lines, right into the odd ones, negated in lines
    // 4–7 so the first echoes of a side don't all reach an output with the same sign (that would
    // boost the lows of every hit). Left and right are two orthogonal sums of the lines
    // (decorrelated).
    const size = this.lineSize;
    const norm = 1 / Math.sqrt(8);
    const mixConst = p.mix.length === 1;
    let dry = this.dryGain;
    let wet = this.wetGain;
    let peakWet = this.peakWet;
    for (let j = 0; j < m; j++) {
      const y0 = Y[j] as number;
      const y1 = Y[CONTROL + j] as number;
      const y2 = Y[2 * CONTROL + j] as number;
      const y3 = Y[3 * CONTROL + j] as number;
      const y4 = Y[4 * CONTROL + j] as number;
      const y5 = Y[5 * CONTROL + j] as number;
      const y6 = Y[6 * CONTROL + j] as number;
      const y7 = Y[7 * CONTROL + j] as number;
      const wetL = y0 - y1 + y2 - y3 + y4 - y5 + y6 - y7;
      const wetR = y0 + y1 - y2 - y3 + y4 + y5 - y6 - y7;
      const t0 = y0 + y1;
      const t1 = y0 - y1;
      const t2 = y2 + y3;
      const t3 = y2 - y3;
      const t4 = y4 + y5;
      const t5 = y4 - y5;
      const t6 = y6 + y7;
      const t7 = y6 - y7;
      const u0 = t0 + t2;
      const u1 = t1 + t3;
      const u2 = t0 - t2;
      const u3 = t1 - t3;
      const u4 = t4 + t6;
      const u5 = t5 + t7;
      const u6 = t4 - t6;
      const u7 = t5 - t7;
      const l = sL[j] as number;
      const r = sR[j] as number;
      const at = (base0 + j) & lineMask;
      lines[at] = (u0 + u4) * norm + l;
      lines[size + at] = (u1 + u5) * norm + r;
      lines[2 * size + at] = (u2 + u6) * norm + l;
      lines[3 * size + at] = (u3 + u7) * norm + r;
      lines[4 * size + at] = (u0 - u4) * norm - l;
      lines[5 * size + at] = (u1 - u5) * norm - r;
      lines[6 * size + at] = (u2 - u6) * norm - l;
      lines[7 * size + at] = (u3 - u7) * norm - r;
      const aw = Math.abs(wetL) + Math.abs(wetR);
      if (aw > peakWet) peakWet = aw;
      if (!mixConst) {
        this.setMix(p.mix[from + j] as number);
        dry = this.dryGain;
        wet = this.wetGain;
      }
      outL[from + j] = dry * (inL[from + j] as number) + wet * wetL;
      outR[from + j] = dry * (inR[from + j] as number) + wet * wetR;
    }
    this.peakWet = peakWet;
    this.lineW = (base0 + m - 1) & lineMask;
  }

  private clear(): void {
    this.lines.fill(0);
    this.pre.fill(0);
    for (let k = 0; k < N; k++) {
      (this.diff[k] as Float32Array).fill(0);
      (this.loop[k] as Float32Array).fill(0);
    }
    this.zLow.fill(0);
    this.zHigh.fill(0);
    this.zIn.fill(0);
    this.ap.fill(0);
  }

  /** The block's Decay, Damping and Size: glide there (or snap on the first block). */
  private targets(decay: number, damping: number, size: number): void {
    const d = Math.min(20, Math.max(0.05, decay));
    const dm = Math.min(1, Math.max(0, damping));
    const s = Math.min(1, Math.max(0, size));
    if (d !== this.decayTo || dm !== this.dampingTo || s !== this.sizeTo) {
      this.decayTo = d;
      this.dampingTo = dm;
      this.sizeTo = s;
      this.settling = true;
    }
    if (this.fresh) {
      this.fresh = false;
      this.decay = d;
      this.damping = dm;
      this.size = s;
      this.settling = true;
      this.control();
      // Start every line at its length (no glide from the constructor's defaults).
      this.delay.set(this.goal);
      this.step.fill(0);
      this.gain.set(this.gainTo);
      this.gainStep.fill(0);
      this.inScale = this.inScaleTo;
      this.inScaleStep = 0;
      for (let k = 0; k < N; k++) this.split(k);
      this.countdown = CONTROL;
    }
  }

  /** Control-rate update: smoothing, line lengths and modulation, coefficients while settling. */
  private control(): void {
    if (this.settling) {
      this.decay += (this.decayTo - this.decay) * this.kSmooth;
      this.damping += (this.dampingTo - this.damping) * this.kSmooth;
      this.size += (this.sizeTo - this.size) * this.kSize;
      const done =
        Math.abs(this.decay - this.decayTo) < 1e-4 * this.decayTo &&
        Math.abs(this.damping - this.dampingTo) < 1e-4 &&
        Math.abs(this.size - this.sizeTo) < 1e-5;
      if (done) {
        this.decay = this.decayTo;
        this.damping = this.dampingTo;
        this.size = this.sizeTo;
      }
      this.coefficients();
      this.settling = !done;
    }
    // Gains and the input level ramp to their new values over the next CONTROL frames.
    for (let k = 0; k < N; k++) {
      this.gainStep[k] = ((this.gainTo[k] as number) - (this.gain[k] as number)) / CONTROL;
    }
    this.inScaleStep = (this.inScaleTo - this.inScale) / CONTROL;
    const goal = this.goal;
    const delay = this.delay;
    const step = this.step;
    // Reading a line before writing it adds a frame to its loop.
    for (let k = 0; k < N; k++) goal[k] = (this.nominal[k] as number) - 1;
    const dt = CONTROL / this.sr;
    for (let m = 0; m < MOD_LINES.length; m++) {
      const ph = (this.phase[m] as number) + (MOD_RATES[m] as number) * dt;
      this.phase[m] = ph >= 1 ? ph - 1 : ph;
      const k = MOD_LINES[m] as number;
      goal[k] = (goal[k] as number) + this.modDepth * Math.sin(2 * Math.PI * (ph + m / MOD_LINES.length));
    }
    for (let k = 0; k < N; k++) {
      const to = goal[k] as number;
      const s = (to - (delay[k] as number)) / CONTROL;
      if (Math.abs(s) < 1e-9) {
        // Arrived: the line holds still (and skips its per-frame coefficient update).
        if (step[k] !== 0 || delay[k] !== to) {
          step[k] = 0;
          delay[k] = to;
          this.split(k);
        }
      } else step[k] = s > MAX_STEP ? MAX_STEP : s < -MAX_STEP ? -MAX_STEP : s;
    }
  }

  /** whole/coef for line k's current delay (lines that don't move keep theirs). */
  private split(k: number): void {
    const d = this.delay[k] as number;
    const di = (d - 0.5) | 0;
    const f = d - di;
    this.whole[k] = di;
    this.coef[k] = (1 - f) / (1 + f);
  }

  /** Line lengths, per-line gains and shelves, and the input level for the smoothed params. */
  private coefficients(): void {
    const sr = this.sr;
    const scale = MIN_SCALE + (1 - MIN_SCALE) * this.size;
    const rt = this.decay;
    const rtLow = rt * LOW_RATIO;
    const rtHigh = rt * (1 - HIGH_DAMP * this.damping);
    const highLevel = HIGH_LEVEL * (1 - 0.5 * this.damping);
    const sh = this.shelf;
    // The input shelf goes through the scratch slots past the lines' coefficients.
    shelfInto(sh, 4 * N, 1, highLevel, this.omegaHigh);
    const inB0 = sh[4 * N] as number;
    const inB1 = sh[4 * N + 1] as number;
    this.inB0 = inB0;
    this.inB1 = inB1;
    let energy = 0;
    for (let k = 0; k < N; k++) {
      this.nominal[k] = ((LINE_MS[k] as number) / 1000) * scale * sr;
      // A round trip also goes through the line's allpass (its delay on average).
      const len = (this.nominal[k] as number) + (this.loop[k] as Float32Array).length;
      // e^(−ln(1000)·len/(RT60·sr)) per round trip: 60 dB down after RT60 seconds.
      const g = Math.exp((-LN_1000 * len) / (rt * sr));
      this.gainTo[k] = g;
      shelfInto(sh, 4 * k, Math.exp((-LN_1000 * len) / (rtLow * sr)) / g, 1, this.omegaLow);
      shelfInto(sh, 4 * k + 2, 1, Math.exp((-LN_1000 * len) / (rtHigh * sr)) / g, this.omegaHigh);
      const l0 = sh[4 * k] as number;
      const l1 = sh[4 * k + 1] as number;
      const h0 = sh[4 * k + 2] as number;
      const h1 = sh[4 * k + 3] as number;
      // Energy that comes out of this line for a unit impulse into the reverb: Σ G^2k over the round trips.
      for (let j = 0; j < ENERGY_POINTS; j++) {
        const c = this.cosW[j] as number;
        const G2 = g * g * shelfPower(l0, l1, this.aLow, c) * shelfPower(h0, h1, this.aHigh, c);
        energy += ((this.weightW[j] as number) * shelfPower(inB0, inB1, this.aHigh, c) * G2) / (1 - G2);
      }
    }
    // The output sums add 8 lines: their 1/√8 is folded in here.
    energy *= 8 / (N * ENERGY_POINTS);
    // ×1.05: measured, the estimate leaves the tail about 0.4 dB short of unit energy.
    this.inScaleTo = energy > 0 ? 1.05 / Math.sqrt(energy) : 0;
  }

  private setMix(m: number): void {
    if (m === this.mixFor) return;
    this.mixFor = m;
    this.dryGain = Math.cos(m * HALF_PI);
    this.wetGain = Math.sin(m * HALF_PI);
  }

  private preFrames(seconds: number): number {
    const f = seconds * this.sr;
    const max = this.preSize - 4;
    return f > 0 ? (f < max ? f : max) : 0;
  }
}

/**
 * Writes the feed-forward coefficients b0, b1 (at `at`, `at + 1`) of a first-order shelf with gain
 * `dc` at DC and `nyquist` at Nyquist, corner `omega` = tan(π·f/sr): the bilinear transform of
 * (nyquist·s + dc·Ω)/(s + Ω). Its feedback coefficient is (Ω − 1)/(Ω + 1).
 */
function shelfInto(out: Float64Array, at: number, dc: number, nyquist: number, omega: number): void {
  out[at] = (nyquist + dc * omega) / (1 + omega);
  out[at + 1] = (dc * omega - nyquist) / (1 + omega);
}

/** |H(e^jω)|² of a first-order section (b0 + b1·z⁻¹)/(1 + a1·z⁻¹), given cos ω. */
function shelfPower(b0: number, b1: number, a1: number, cos: number): number {
  return (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cos) / (1 + a1 * a1 + 2 * a1 * cos);
}
