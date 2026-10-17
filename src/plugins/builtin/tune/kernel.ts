import {
  at,
  DelayLine,
  EffectKernel,
  pow2,
  Readings,
  Yin,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { RANGE_HZ, RANGES, TUNE_SCALES, tuneLatencyFrames, type tuneParams } from './params';

type P = typeof tuneParams;

/** A new pitch estimate every HOP frames. */
const HOP = 256;
/** Keep the current note until another is this much (semitones) nearer: no flicker in between. */
const HYSTERESIS = 0.2;
/** Detections less sure than this count as unvoiced. */
const MIN_CONFIDENCE = 0.6;
/** Corrections smaller than this (cents) let the shifter rest (output = the delayed input). */
const REST_CENTS = 1;
/** How fast a resting read head drifts back to its centre, frames per frame (≈ 3 cents). */
const REST_RATE = 0.002;
/** Largest correction applied, semitones. */
const MAX_SHIFT = 12;
/** Length of a splice's crossfade, seconds. */
const SPLICE_SECONDS = 0.004;
/** The period assumed when none was found yet, seconds (a splice then just jumps this far). */
const FALLBACK_PERIOD = 0.005;

/** Pitch-class masks (bit n = n semitones above the root) of every scale, by enum index. */
const MASKS = TUNE_SCALES.map((s) => s.intervals.reduce<number>((m, i) => m | (1 << i), 0));

/**
 * The nearest note of a key and scale to a pitch (fractional MIDI note), keeping `current` while
 * it is within HYSTERESIS of being as near (−1 for none).
 */
export function nearestNote(midi: number, root: number, mask: number, current: number): number {
  let best = -1;
  let bestDist = Infinity;
  const centre = Math.round(midi);
  for (let n = centre - 6; n <= centre + 6; n++) {
    const pc = (((n - root) % 12) + 12) % 12;
    if (!(mask & (1 << pc))) continue;
    const d = Math.abs(midi - n);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  if (current >= 0 && best !== current) {
    const pc = (((current - root) % 12) + 12) % 12;
    if (mask & (1 << pc) && Math.abs(midi - current) <= bestDist + HYSTERESIS) return current;
  }
  return best;
}

/**
 * Scale pitch correction. YIN (SDK) finds the pitch every 256 frames; the target is the nearest
 * note of the key and scale (with hysteresis), and the correction glides there with Retune speed.
 *
 * The shifter is a pitch-synchronous splicer: one read head moves through a delay line at the
 * corrected speed; when it drifts too far from its resting delay, a second head starts a whole
 * number of detected periods away (so both read the same point of the waveform) and a short
 * crossfade hands over to it. No phase cancellation, no pitch bias. With nothing to correct the
 * head rests at the centre: the output is exactly the input delayed by the reported latency, and
 * the dry signal for the mix is read at the same delay.
 */
export class TuneKernel extends EffectKernel<P> {
  readonly latency = tuneLatencyFrames(this.sampleRate);
  private readonly splice = Math.max(16, Math.round(SPLICE_SECONDS * this.sampleRate));
  /** How far the head may stray from the centre before splicing. */
  private readonly reach = this.latency - this.splice - 8;
  private readonly lines = [new DelayLine(4 * this.latency + 64), new DelayLine(4 * this.latency + 64)];
  private readonly detectors: Yin[];
  private readonly meter = new Readings(this.host, ['pitch', 'target', 'cents'] as const);
  private range = -1;
  private hop = 0;
  private target = -1;
  /** The correction being applied, cents (glides towards `goal`). */
  private cents = 0;
  /** `drift` is the read-speed change for `driftCents` (the cents it was computed from). */
  private driftCents = Number.NaN;
  private drift = 0;
  private goal = 0;
  private speed = -1;
  private glide = 1;
  /** The playing head's delay, frames, and the incoming one's during a splice. */
  private head: number;
  private next = 0;
  /** Frames into the current splice (−1: none). */
  private fade = -1;
  /** The last period found, frames. */
  private period: number;

  constructor(host: KernelHost) {
    super(host);
    this.detectors = RANGES.map((r) => {
      const [minHz, maxHz] = RANGE_HZ[r];
      return new Yin(this.sampleRate, { minHz, maxHz });
    });
    this.head = this.latency;
    this.period = FALLBACK_PERIOD * this.sampleRate;
    const v = this.meter.values;
    v.pitch = 0;
    v.target = -1;
    v.cents = 0;
  }

  override reset(): void {
    for (const l of this.lines) l.clear();
    for (const d of this.detectors) d.reset();
    this.target = -1;
    this.cents = 0;
    this.goal = 0;
    this.head = this.latency;
    this.fade = -1;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const range = Math.round(p.range[0] as number);
    if (range !== this.range) {
      this.range = range;
      this.detectors[range]?.reset();
      this.target = -1;
    }
    const yin = (this.detectors[range] ?? this.detectors[1]) as Yin;
    const root = Math.round(p.key[0] as number);
    const mask = MASKS[Math.round(p.scale[0] as number)] ?? 0xfff;
    const lineL = this.lines[0] as DelayLine;
    const lineR = this.lines[1] as DelayLine;
    const centre = this.latency;
    for (let i = 0; i < n; i++) {
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      yin.push(0.5 * (xl + xr));
      if (++this.hop >= HOP) {
        this.hop = 0;
        this.retarget(yin, root, mask);
      }
      const speed = at(p.speed, i);
      if (speed !== this.speed) {
        this.speed = speed;
        this.glide = speed > 0 ? 1 - Math.exp(-1000 / (speed * this.sampleRate)) : 1;
      }
      this.cents += (this.goal - this.cents) * this.glide;
      // A delay that grows by (1 − ratio) per frame plays `ratio` times as fast. The ratio only changes
      // while the correction glides (or retargets), so it is kept between those.
      if (this.cents !== this.driftCents) {
        this.driftCents = this.cents;
        this.drift = 1 - pow2(this.cents / 1200);
      }
      const drift = this.drift;
      if (this.fade < 0 && Math.abs(this.cents) < REST_CENTS) {
        // Nothing to correct: drift back to the centre (where the output is the delayed input).
        const off = this.head - centre;
        this.head = off > REST_RATE ? this.head - REST_RATE : off < -REST_RATE ? this.head + REST_RATE : centre;
      } else {
        this.head += drift;
        if (this.fade >= 0) this.next += drift;
        else if (this.head < centre - this.reach || this.head > centre + this.reach) this.startSplice();
      }
      lineL.write(xl);
      lineR.write(xr);
      let wl = lineL.readCubic(this.head);
      let wr = lineR.readCubic(this.head);
      if (this.fade >= 0) {
        const t = (this.fade + 1) / this.splice;
        const g = 0.5 - 0.5 * Math.cos(Math.PI * t);
        wl += g * (lineL.readCubic(this.next) - wl);
        wr += g * (lineR.readCubic(this.next) - wr);
        if (++this.fade >= this.splice) {
          this.head = this.next;
          this.fade = -1;
        }
      }
      const dl = lineL.read(centre);
      const dr = lineR.read(centre);
      const mix = at(p.mix, i);
      outL[i] = dl + mix * (wl - dl);
      outR[i] = dr + mix * (wr - dr);
    }
    this.meter.tick(n);
  }

  /** Hands over to a head a whole number of periods back towards the centre. */
  private startSplice(): void {
    const period = this.period;
    const distance = Math.abs(this.head - this.latency) + this.reach;
    const jump = period * Math.max(1, Math.round(distance / period));
    this.next = this.head < this.latency ? this.head + jump : this.head - jump;
    // Never read closer than the cubic reader allows.
    if (this.next < 2) this.next += period * Math.ceil((2 - this.next) / period);
    this.fade = 0;
  }

  /** A new pitch estimate: pick the note to pull to, and the correction to get there. */
  private retarget(yin: Yin, root: number, mask: number): void {
    const f = yin.detect();
    const v = this.meter.values;
    if (f <= 0 || yin.confidence < MIN_CONFIDENCE) {
      this.target = -1;
      this.goal = 0;
      v.pitch = 0;
      v.target = -1;
      v.cents = this.cents;
      return;
    }
    this.period = this.sampleRate / f;
    const midi = 69 + 12 * Math.log2(f / 440);
    this.target = nearestNote(midi, root, mask, this.target);
    const shift = this.target - midi;
    this.goal = 100 * (shift > MAX_SHIFT ? MAX_SHIFT : shift < -MAX_SHIFT ? -MAX_SHIFT : shift);
    v.pitch = f;
    v.target = this.target;
    v.cents = this.cents;
  }
}
