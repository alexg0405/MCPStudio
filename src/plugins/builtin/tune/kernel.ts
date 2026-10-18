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
/**
 * How fast a resting read head drifts back to its centre, frames per frame (≈ 6 cents): only what is left after the jumps
 * below (less than half a period, or less than one frame), so the drift is short and stays far under a vibrato.
 */
const REST_RATE = 0.0035;
/** The drift until a rest has lasted REST_HOLD: what it always was (≈ 3 cents). */
const REST_RATE_SLOW = 0.002;
/**
 * After a correction ends the read head is a few milliseconds off its centre. While the voice sounds it jumps back a
 * whole number of periods (the same waveform point, with the splice's crossfade); once no pitch has been found for this
 * many detections (≈ 43 ms) nothing pitched needs lining up and it crosses straight to the centre. Either way the output
 * is the delayed input again within a few milliseconds, instead of after seconds of drifting.
 */
const UNPITCHED_HOPS = 8;
/** The correction must have stayed below REST_CENTS this long (seconds) before the head is brought back (a glide crossing a note is not an end). */
const REST_HOLD = 0.03;
/** Largest correction applied, semitones. */
const MAX_SHIFT = 12;
/** Length of a splice's crossfade, seconds. */
const SPLICE_SECONDS = 0.004;
/** The period assumed when none was found yet, seconds (a splice then just jumps this far). */
const FALLBACK_PERIOD = 0.005;

/** Played notes the kernel keeps track of at once (a chord of more is rare; the oldest goes). */
const MAX_HELD = 16;
/** Time constants (seconds) of the slow pitch line and the note average that "keep natural drift" compares. */
const DRIFT_SLOW_TAU = 0.1;
const DRIFT_AVG_TAU = 1;
/** Seconds the added vibrato takes to fade in after a note starts. */
const VIBRATO_FADE = 0.35;
/** Grains that can sound at once in "keep formants" mode (up to 4 overlap at the largest shift, plus the next). */
const MAX_GRAINS = 8;
/** Size of the grain window table (a Hann curve, read with interpolation). */
const WINDOW_SIZE = 512;
const TWO_PI = Math.PI * 2;

/** One Hann curve over 0..1, shared by every kernel (built once, outside process()). */
const WINDOW = (() => {
  const t = new Float32Array(WINDOW_SIZE + 1);
  for (let i = 0; i <= WINDOW_SIZE; i++) t[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / WINDOW_SIZE);
  return t;
})();

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
 * the dry signal for the mix is read at the same delay. When a correction ends (it stays under a
 * cent for 30 ms) the head goes home the same way it splices: a whole number of periods while the
 * voice sounds, straight to the centre once no pitch has been found for ~43 ms, so the output is
 * the delayed input again within milliseconds of a pause and under a second of a held note.
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

  // ---- Played notes (Target = notes) ----
  private readonly heldKeys = new Int16Array(MAX_HELD);
  private readonly heldIds = new Int32Array(MAX_HELD);
  private held = 0;

  // ---- Keep natural drift: the singer's slow line and its long average, in cents ----
  private slowC = 0;
  private avgC = 0;
  private driftFresh = true;
  private readonly slowA = 1 - Math.exp(-HOP / (DRIFT_SLOW_TAU * this.sampleRate));
  private readonly avgA = 1 - Math.exp(-HOP / (DRIFT_AVG_TAU * this.sampleRate));

  // ---- Added vibrato ----
  private vibPhase = 0;
  private vibEnv = 0;
  private readonly vibFade = HOP / (VIBRATO_FADE * this.sampleRate);

  // ---- Keep formants: overlapped grains read at their own speed (pitch-synchronous OLA) ----
  /** Per grain: its delay behind the write head (constant: it plays at speed 1), the offset from its centre, its half width (0 = free). */
  private readonly gDelay = new Float64Array(MAX_GRAINS);
  private readonly gAt = new Float64Array(MAX_GRAINS);
  private readonly gHalf = new Float64Array(MAX_GRAINS);
  /** A frame counter (only counted while the mode is on), and the sequence of grains: next centre and half width, last analysis centre. */
  private frame = 0;
  private seq = false;
  private nextCentre = 0;
  private nextHalf = 0;
  private lastCentre = 0;
  /** True while the last detection found a pitch with something to pull to. */
  private voiced = false;
  /** Detections in a row that found no pitch at all (the voice is silent or unpitched). */
  private unpitched = 0;
  /** Frames the correction has been under REST_CENTS, and how long it takes to count as over. */
  private restFor = 0;
  private readonly restHold = Math.round(REST_HOLD * this.sampleRate);

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
    this.held = 0;
    this.driftFresh = true;
    this.vibEnv = 0;
    this.unpitched = 0;
    this.restFor = 0;
    this.stopGrains();
  }

  // ---- Played notes ----

  override noteOn(key: number, _velocity: number, noteId: number): void {
    for (let i = 0; i < this.held; i++) {
      if (this.heldIds[i] === noteId) {
        this.heldKeys[i] = key;
        return;
      }
    }
    if (this.held === MAX_HELD) {
      // The oldest goes.
      this.heldKeys.copyWithin(0, 1);
      this.heldIds.copyWithin(0, 1);
      this.held--;
    }
    this.heldKeys[this.held] = key;
    this.heldIds[this.held] = noteId;
    this.held++;
  }

  override noteOff(noteId: number): void {
    for (let i = 0; i < this.held; i++) {
      if (this.heldIds[i] !== noteId) continue;
      this.heldKeys.copyWithin(i, i + 1, this.held);
      this.heldIds.copyWithin(i, i + 1, this.held);
      this.held--;
      return;
    }
  }

  override allNotesOff(): void {
    this.held = 0;
  }

  /** The held note nearest to a pitch (fractional MIDI), keeping `current` while it is held and within HYSTERESIS of as near (-1: none held). */
  private nearestHeld(midi: number, current: number): number {
    let best = -1;
    let bestDist = Infinity;
    let currentHeld = false;
    for (let i = 0; i < this.held; i++) {
      const k = this.heldKeys[i] as number;
      if (k === current) currentHeld = true;
      const d = Math.abs(midi - k);
      if (d < bestDist || (d === bestDist && k < best)) {
        bestDist = d;
        best = k;
      }
    }
    if (currentHeld && best !== current && Math.abs(midi - current) <= bestDist + HYSTERESIS) return current;
    return best;
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
    const fromNotes = Math.round(p.source[0] as number) === 1;
    const humanize = p.humanize[0] as number;
    const vibDepth = p.vibratoDepth[0] as number;
    const vibInc = (p.vibratoRate[0] as number) / this.sampleRate;
    const formant = (p.formant[0] as number) > 0.5;
    if (!formant && this.seq) this.stopGrains();
    const lineL = this.lines[0] as DelayLine;
    const lineR = this.lines[1] as DelayLine;
    const centre = this.latency;
    for (let i = 0; i < n; i++) {
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      yin.push(0.5 * (xl + xr));
      if (++this.hop >= HOP) {
        this.hop = 0;
        this.retarget(yin, root, mask, fromNotes, humanize);
      }
      const speed = at(p.speed, i);
      if (speed !== this.speed) {
        this.speed = speed;
        this.glide = speed > 0 ? 1 - Math.exp(-1000 / (speed * this.sampleRate)) : 1;
      }
      if (vibDepth > 0) {
        this.vibPhase += vibInc;
        if (this.vibPhase >= 1) this.vibPhase -= 1;
        const vib = vibDepth * this.vibEnv * Math.sin(TWO_PI * this.vibPhase);
        this.cents += (this.goal + vib - this.cents) * this.glide;
      } else this.cents += (this.goal - this.cents) * this.glide;
      // A delay that grows by (1 - ratio) per frame plays `ratio` times as fast. The ratio only changes
      // while the correction glides (or retargets), so it is kept between those.
      if (this.cents !== this.driftCents) {
        this.driftCents = this.cents;
        this.drift = 1 - pow2(this.cents / 1200);
      }
      const drift = this.drift;
      if (Math.abs(this.cents) < REST_CENTS) {
        if (this.restFor < this.restHold) this.restFor++;
      } else this.restFor = 0;
      if (this.fade < 0 && Math.abs(this.cents) < REST_CENTS) {
        // Nothing to correct: back to the centre (where the output is the delayed input).
        const off = this.head - centre;
        if (off > REST_RATE || off < -REST_RATE) this.rest(off);
        else this.head = centre;
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
      if (formant) {
        const c = this.grains(lineL, lineR, 1 - this.drift);
        if (c > 0) {
          wl += (this.grainL - wl) * c;
          wr += (this.grainR - wr) * c;
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

  /** Grain mode's wet output for this frame (set by `grains`). */
  private grainL = 0;
  private grainR = 0;

  /**
   * Keep formants. Pitch-synchronous overlap-add: a grain is two periods of the voice under a Hann window,
   * read at the voice's own speed (so its formants stay), and grains are laid down one new period apart
   * (period / ratio), each taken from the nearest point of the voice's own period grid, so a rise repeats some
   * periods and a fall skips some. Returns how much of the wet sound this frame the grains supply (0-1; it
   * ramps in and out with the first and last grain), with the sound in `grainL` / `grainR`.
   */
  private grains(lineL: DelayLine, lineR: DelayLine, ratio: number): number {
    const frame = this.frame++;
    if (this.voiced) {
      const period = this.period;
      if (!this.seq) {
        this.seq = true;
        this.nextHalf = period;
        this.nextCentre = frame + period;
        // The first grain reads exactly the latency behind: no shift, no offset.
        this.lastCentre = this.nextCentre - this.latency;
      }
      // Spawn every grain that is due (one at a time at the usual rates).
      let guard = 0;
      while (frame >= this.nextCentre - this.nextHalf && guard++ < 4) {
        let slot = -1;
        for (let g = 0; g < MAX_GRAINS; g++) {
          if (this.gHalf[g] === 0) {
            slot = g;
            break;
          }
        }
        const centre = this.nextCentre;
        const half = this.nextHalf;
        if (slot >= 0) {
          const k = Math.round((centre - this.latency - this.lastCentre) / period);
          const source = this.lastCentre + k * period;
          this.lastCentre = source;
          this.gDelay[slot] = centre - source;
          this.gAt[slot] = -half;
          this.gHalf[slot] = half;
        }
        const out = period / (ratio > 0.5 ? ratio : 0.5);
        this.nextCentre = centre + out;
        // Wider windows keep a fall of up to an octave from leaving gaps between grains.
        this.nextHalf = Math.max(period, 0.75 * out);
      }
    } else if (this.seq) this.seq = false;
    let sum = 0;
    let sl = 0;
    let sr = 0;
    for (let g = 0; g < MAX_GRAINS; g++) {
      const half = this.gHalf[g] as number;
      if (half === 0) continue;
      const offset = this.gAt[g] as number;
      const u = ((offset + half) / (2 * half)) * WINDOW_SIZE;
      const i = u | 0;
      const w = (WINDOW[i] as number) + ((WINDOW[i + 1] as number) - (WINDOW[i] as number)) * (u - i);
      const delay = this.gDelay[g] as number;
      sum += w;
      sl += w * lineL.readCubic(delay);
      sr += w * lineR.readCubic(delay);
      if (offset + 1 >= half) this.gHalf[g] = 0;
      else this.gAt[g] = offset + 1;
    }
    if (sum < 1e-6) return 0;
    this.grainL = sl / sum;
    this.grainR = sr / sum;
    const c = sum / (0.9 * ratio);
    return c > 1 ? 1 : c;
  }

  /** Lets every grain go (the sequence starts afresh at the next voiced note). */
  private stopGrains(): void {
    this.gHalf.fill(0);
    this.seq = false;
  }

  /**
   * The head is `off` frames from its centre with nothing to correct: start a crossfade to a head nearer the centre
   * (a whole number of periods away while a pitch is known, straight to the centre once the voice has been unpitched
   * for a while), else drift the last stretch. Never allocates.
   */
  private rest(off: number): void {
    const period = this.period;
    // A glide through a note, or a moment of in-tune pitch, is not the end of a correction: only the slow drift until it has lasted.
    if (this.restFor < this.restHold) {
      this.head += off > 0 ? -REST_RATE_SLOW : REST_RATE_SLOW;
      return;
    }
    if (this.unpitched >= UNPITCHED_HOPS && (off > 0.5 || off < -0.5)) {
      this.next = this.latency;
      this.fade = 0;
      return;
    }
    const jumps = Math.round(off / period);
    if (jumps !== 0) {
      const next = this.head - jumps * period;
      // Never read closer than the cubic reader allows.
      if (next >= 2) {
        this.next = next;
        this.fade = 0;
        return;
      }
    }
    this.head += off > 0 ? -REST_RATE : REST_RATE;
  }

  /** How far the read head is from its centre (frames; 0 = the output is the delayed input). For tests and meters. */
  get headOffset(): number {
    return this.head - this.latency;
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
  private retarget(yin: Yin, root: number, mask: number, fromNotes: boolean, humanize: number): void {
    const f = yin.detect();
    const v = this.meter.values;
    if (f <= 0 || yin.confidence < MIN_CONFIDENCE) {
      if (this.unpitched < 1e6) this.unpitched++;
      this.target = -1;
      this.goal = 0;
      this.voiced = false;
      this.driftFresh = true;
      this.vibEnv = 0;
      v.pitch = 0;
      v.target = -1;
      v.cents = this.cents;
      return;
    }
    this.period = this.sampleRate / f;
    this.unpitched = 0;
    const midi = 69 + 12 * Math.log2(f / 440);
    const previous = this.target;
    this.target = fromNotes ? this.nearestHeld(midi, this.target) : nearestNote(midi, root, mask, this.target);
    if (this.target < 0) {
      // Target = notes, and none is held: the voice is left as it is.
      this.goal = 0;
      this.voiced = false;
      this.driftFresh = true;
      this.vibEnv = 0;
      v.pitch = f;
      v.target = -1;
      v.cents = this.cents;
      return;
    }
    this.voiced = true;
    const shift = this.target - midi;
    this.goal = 100 * (shift > MAX_SHIFT ? MAX_SHIFT : shift < -MAX_SHIFT ? -MAX_SHIFT : shift);
    if (humanize > 0) {
      // Leave a share of the slow wandering (the slow line against the note's own average) in the voice.
      const c = midi * 100;
      if (this.target !== previous || this.driftFresh) {
        this.slowC = c;
        this.avgC = c;
        this.driftFresh = false;
      } else {
        this.slowC += (c - this.slowC) * this.slowA;
        this.avgC += (c - this.avgC) * this.avgA;
      }
      const g = this.goal + humanize * (this.slowC - this.avgC);
      this.goal = g > 100 * MAX_SHIFT ? 100 * MAX_SHIFT : g < -100 * MAX_SHIFT ? -100 * MAX_SHIFT : g;
    }
    this.vibEnv = this.target === previous ? Math.min(1, this.vibEnv + this.vibFade) : 0;
    v.pitch = f;
    v.target = this.target;
    v.cents = this.cents;
  }
}
