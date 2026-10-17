import { at, DelayLine, EffectKernel, OnePole, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import type { doublerParams } from './params';

type P = typeof doublerParams;

const MAX_VOICES = 4;
/** Delay targets and gains are computed every CONTROL frames and ramped in between. */
const CONTROL = 32;
const TWO_PI = 2 * Math.PI;
/** 1200 / ln 2: cents = CENTS · ln(pitch ratio), and a pitch ratio is 1 − (change of delay per second). */
const CENTS = 1731.2340490667561;
/** The timing of each voice against the Delay knob (spread 100 % uses these; 0 % puts every voice at 1). */
const TIMING = [1, 1.45, 0.72, 1.9] as const;
/** Where each voice sits between left (−1) and right (+1) at 100 % width. */
const PAN = [-1, 1, -0.6, 0.6] as const;
/** How fast each voice's pitch drifts, Hz: slow and unrelated, so the voices never move together. */
const DRIFT_HZ = [0.43, 0.57, 0.79, 1.03] as const;
/** A voice drifts with two sines: the second is this much faster and this share of the cents. */
const SECOND = 1.71;
const WEIGHT_1 = 0.65;
const WEIGHT_2 = 0.35;
/** Longest delay the line must hold: the Delay's maximum × the widest timing, plus the drift, in ms. */
const MAX_MS = 50 * 1.9 + 8;

/**
 * Doubler: two to four extra "takes" of a voice. The input is summed to mono, darkened, and read
 * back from one delay line by each voice at its own delay (timing spread) that wanders slowly (a
 * pair of sines per voice, scaled so the pitch error peaks at the Pitch drift in cents), then panned
 * between the sides with the Width. The original passes through untouched in the middle, so the sum
 * of left and right in mono is the voice plus a few quiet delayed copies (a comb of shallow notches
 * that the wandering delays smear), not a hollow sound.
 */
export class DoublerKernel extends EffectKernel<P> {
  private readonly line = new DelayLine(Math.ceil((MAX_MS * this.sampleRate) / 1000));
  private readonly tone = new OnePole();
  /** Current delay (frames) and its change per frame, per voice. */
  private readonly delays = new Float64Array(MAX_VOICES);
  private readonly steps = new Float64Array(MAX_VOICES);
  /** Current left and right gain of each voice and the change per frame. */
  private readonly gl = new Float64Array(MAX_VOICES);
  private readonly gr = new Float64Array(MAX_VOICES);
  private readonly dgl = new Float64Array(MAX_VOICES);
  private readonly dgr = new Float64Array(MAX_VOICES);
  /** Drift phases (0–1 cycles) of the two sines of each voice. */
  private readonly phase1 = new Float64Array(MAX_VOICES);
  private readonly phase2 = new Float64Array(MAX_VOICES);
  /** Voices whose delays are running (those above it start at their target, silent, and fade in). */
  private active = 0;
  private countdown = 0;
  private cutoff = -1;

  constructor(host: KernelHost) {
    super(host);
    for (let v = 0; v < MAX_VOICES; v++) {
      this.phase1[v] = this.host.rand();
      this.phase2[v] = this.host.rand();
    }
  }

  override reset(): void {
    this.line.clear();
    this.tone.reset();
    this.delays.fill(0);
    this.steps.fill(0);
    this.gl.fill(0);
    this.gr.fill(0);
    this.dgl.fill(0);
    this.dgr.fill(0);
    this.active = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const voices = Math.max(2, Math.min(MAX_VOICES, Math.round(p.voices[0] as number)));
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.control(i, voices, p);
      }
      this.countdown--;
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      this.line.write(this.tone.process(0.5 * (xl + xr)));
      let wl = 0;
      let wr = 0;
      for (let v = 0; v < this.active; v++) {
        const d = (this.delays[v] as number) + (this.steps[v] as number);
        this.delays[v] = d;
        const s = this.line.readCubic(d);
        const l = (this.gl[v] as number) + (this.dgl[v] as number);
        const r = (this.gr[v] as number) + (this.dgr[v] as number);
        this.gl[v] = l;
        this.gr[v] = r;
        wl += s * l;
        wr += s * r;
      }
      outL[i] = xl + wl;
      outR[i] = xr + wr;
    }
  }

  /** The next delay and gain targets for every voice, reached by a straight line over CONTROL frames. */
  private control(i: number, voices: number, p: ParamBlock<P>): void {
    const sr = this.sampleRate;
    const cutoff = at(p.tone, i);
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      this.tone.setCutoff(cutoff, sr);
    }
    const base = (at(p.delay, i) * sr) / 1000;
    const spread = at(p.spread, i);
    const cents = at(p.drift, i);
    const width = at(p.width, i);
    const level = Math.pow(10, at(p.level, i) / 20) / Math.sqrt(voices);
    let top = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      const on = v < voices;
      // The pitch error of a delay that moves is its speed: scale each sine so the two together peak at `cents`.
      const f1 = DRIFT_HZ[v] as number;
      const f2 = f1 * SECOND;
      const a1 = (cents * WEIGHT_1 * sr) / (CENTS * TWO_PI * f1);
      const a2 = (cents * WEIGHT_2 * sr) / (CENTS * TWO_PI * f2);
      const p1 = (this.phase1[v] as number) + (f1 * CONTROL) / sr;
      const p2 = (this.phase2[v] as number) + (f2 * CONTROL) / sr;
      this.phase1[v] = p1 - Math.floor(p1);
      this.phase2[v] = p2 - Math.floor(p2);
      const goal =
        base * (1 + spread * ((TIMING[v] as number) - 1)) +
        a1 * Math.sin(TWO_PI * (this.phase1[v] as number)) +
        a2 * Math.sin(TWO_PI * (this.phase2[v] as number));
      const angle = ((width * (PAN[v] as number) + 1) * Math.PI) / 4;
      const tl = on ? level * Math.cos(angle) : 0;
      const tr = on ? level * Math.sin(angle) : 0;
      if (v >= this.active) {
        // A voice that was off starts at its delay, silent, and fades in over this interval.
        this.delays[v] = goal;
        this.gl[v] = 0;
        this.gr[v] = 0;
      }
      this.steps[v] = (goal - (this.delays[v] as number)) / CONTROL;
      this.dgl[v] = (tl - (this.gl[v] as number)) / CONTROL;
      this.dgr[v] = (tr - (this.gr[v] as number)) / CONTROL;
      if (on || (this.gl[v] as number) > 1e-9 || (this.gr[v] as number) > 1e-9) top = v + 1;
    }
    this.active = top;
  }
}
