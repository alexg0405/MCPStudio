import { at, EffectKernel, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import { REPEAT_BEATS, TRANCE, type stutterParams } from './params';

type P = typeof stutterParams;

const QUARTER = 1;
const EIGHTH = 2;
const SIXTEENTH = 3;
const OFFBEAT = 4;
const TRANCE_GATE = 5;
const DOTTED = 6;
const TRIPLET = 7;
const HALF = 8;
/** History kept for tape stops and for the part of a repeat slice that already went by. */
const HISTORY_SECONDS = 8;
/** The longest slice beat repeat holds (a 1/2 note at 60 BPM). */
const MAX_SLICE_SECONDS = 2;
/** Crossfades at loop points and when an effect lets go, seconds. */
const FADE_SECONDS = 0.003;

const frac = (x: number) => x - Math.floor(x);

/** Whether a gate pattern is open at a song position (in beats). */
export function gateOpen(gate: number, beat: number): boolean {
  switch (gate) {
    case QUARTER:
      return frac(beat) < 0.5;
    case EIGHTH:
      return frac(beat * 2) < 0.5;
    case SIXTEENTH:
      return frac(beat * 4) < 0.5;
    case OFFBEAT:
      return frac(beat) >= 0.5;
    case TRANCE_GATE:
      return TRANCE[Math.floor(frac(beat / 4) * 16)] === 1;
    case DOTTED:
      return frac(beat / 0.75) < 0.5;
    case TRIPLET:
      return frac(beat * 3) < 0.5;
    case HALF:
      return frac(beat / 2) < 0.5;
    default:
      return true;
  }
}

/**
 * Stutter: performance effects locked to the song position (`this.transport`), active only while
 * the song plays (stopped, the audio passes untouched).
 * - Gate: a smoothed on/off pattern (straight, off-beat, trance, dotted, triplet, half-time).
 * - Beat repeat: the slice of the chosen length that starts at the current grid line is captured
 *   (the part already played comes from the history) and looped while Repeat stays on, with short
 *   crossfades at the loop point and when it lets go.
 * - Tape stop: the output slows down to a halt over Stop time (reading the history at a falling
 *   speed), then stays silent until it is switched off.
 */
export class StutterKernel extends EffectKernel<P> {
  private readonly size: number;
  private readonly mask: number;
  private readonly history: Float32Array[];
  private readonly slice: Float32Array[];
  private readonly fade = Math.max(1, Math.round(FADE_SECONDS * this.sampleRate));
  private written = 0;
  private gain = 1;
  // Beat repeat.
  private repeating = false;
  private repeatIndex = 0;
  private sliceLength = 0;
  private slicePos = 0;
  private pass = 0;
  /** Frames left of the crossfade back to the live sound after a repeat or stop ends. */
  private release = 0;
  // Tape stop.
  private stopping = false;
  private stopRead = 0;
  private stopElapsed = 0;
  private stopFrames = 1;
  private wasStop = false;

  constructor(host: KernelHost) {
    super(host);
    let size = 1;
    while (size < HISTORY_SECONDS * this.sampleRate) size <<= 1;
    this.size = size;
    this.mask = size - 1;
    this.history = [new Float32Array(size), new Float32Array(size)];
    const slice = Math.ceil(MAX_SLICE_SECONDS * this.sampleRate) + 2 * this.fade;
    this.slice = [new Float32Array(slice), new Float32Array(slice)];
  }

  override reset(): void {
    for (const h of this.history) h.fill(0);
    this.idle();
    this.gain = 1;
  }

  override transportChanged(): void {
    // A jump, a loop or a stop: captured slices and stops no longer belong where the song is.
    this.idle();
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const t = this.transport;
    const hL = this.history[0] as Float32Array;
    const hR = this.history[1] as Float32Array;
    if (!t.playing) {
      // Stopped: untouched (the history keeps recording for the next start).
      for (let i = 0; i < n; i++) {
        const l = inL[i] as number;
        const r = inR[i] as number;
        hL[this.written & this.mask] = l;
        hR[this.written & this.mask] = r;
        this.written++;
        outL[i] = l;
        outR[i] = r;
      }
      this.gain = 1;
      this.idle();
      return;
    }
    const gate = Math.round(p.gate[0] as number);
    const repeat = Math.round(p.repeat[0] as number);
    const stop = (p.stop[0] as number) >= 0.5;
    const framesPerBeat = (60 / t.bpm) * this.sampleRate;
    if (stop && !this.wasStop) this.startStop(at(p.stopTime, 0) * framesPerBeat);
    if (!stop && this.wasStop && this.stopping) {
      this.stopping = false;
      this.release = this.fade;
    }
    this.wasStop = stop;
    if (repeat !== this.repeatIndex) {
      if (this.repeating) this.release = this.fade;
      this.repeating = false;
      this.repeatIndex = repeat;
    }
    const sL = this.slice[0] as Float32Array;
    const sR = this.slice[1] as Float32Array;
    for (let i = 0; i < n; i++) {
      const beat = t.beatAt(i);
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      let yl = xl;
      let yr = xr;
      // Beat repeat.
      if (repeat > 0 && !this.repeating) this.startRepeat(beat, (REPEAT_BEATS[repeat] ?? 0) * framesPerBeat);
      if (this.repeating) {
        const k = this.slicePos;
        const len = this.sliceLength;
        if (this.pass === 0) {
          sL[k] = xl;
          sR[k] = xr;
        } else {
          // Store what follows the slice once, for the crossfade at each loop point.
          if (this.pass === 1 && k < this.fade) {
            sL[len + k] = xl;
            sR[len + k] = xr;
          }
          yl = sL[k] as number;
          yr = sR[k] as number;
          if (k < this.fade) {
            const a = k / this.fade;
            yl = (sL[len + k] as number) * (1 - a) + yl * a;
            yr = (sR[len + k] as number) * (1 - a) + yr * a;
          }
        }
        if (++this.slicePos >= len) {
          this.slicePos = 0;
          this.pass++;
        }
      }
      hL[this.written & this.mask] = yl;
      hR[this.written & this.mask] = yr;
      this.written++;
      // Tape stop.
      if (this.stopping) {
        const speed = this.stopElapsed < this.stopFrames ? 1 - this.stopElapsed / this.stopFrames : 0;
        this.stopElapsed++;
        if (speed > 0) {
          const g = speed < 0.125 ? speed * 8 : 1;
          yl = this.readHistory(hL, this.stopRead) * g;
          yr = this.readHistory(hR, this.stopRead) * g;
          this.stopRead += speed;
        } else {
          yl = 0;
          yr = 0;
        }
      } else if (this.release > 0) {
        // Back to the live sound after a repeat or a stop: a short fade in.
        const a = 1 - this.release / this.fade;
        yl *= a;
        yr *= a;
        this.release--;
      }
      // Gate.
      const target = gateOpen(gate, beat) ? 1 : 1 - at(p.depth, i);
      const tau = (at(p.smooth, i) / 3000) * this.sampleRate;
      this.gain += (target - this.gain) * (tau > 1 ? 1 / tau : 1);
      const mix = at(p.mix, i);
      const g = this.gain;
      outL[i] = xl + mix * (yl * g - xl);
      outR[i] = xr + mix * (yr * g - xr);
    }
  }

  /** Starts looping the slice whose grid line is at or before `beat`. */
  private startRepeat(beat: number, length: number): void {
    const len = Math.max(
      this.fade + 1,
      Math.min(Math.round(length), (this.slice[0] as Float32Array).length - 2 * this.fade),
    );
    const beats = length / ((60 / this.transport.bpm) * this.sampleRate);
    const into = beats > 0 ? Math.round((beat - Math.floor(beat / beats + 1e-9) * beats) * (len / beats)) : 0;
    const passed = Math.min(len - 1, Math.max(0, into));
    // The part of the slice that already played comes from the history.
    for (let c = 0; c < 2; c++) {
      const h = this.history[c] as Float32Array;
      const s = this.slice[c] as Float32Array;
      for (let k = 0; k < passed; k++) s[k] = h[(this.written - passed + k) & this.mask] as number;
    }
    this.sliceLength = len;
    this.slicePos = passed;
    this.pass = 0;
    this.repeating = true;
  }

  private startStop(frames: number): void {
    this.stopping = true;
    this.stopFrames = Math.max(1, frames);
    this.stopElapsed = 0;
    // The read head starts at the newest sample (written - 1) and falls behind.
    this.stopRead = this.written - 1;
  }

  private readHistory(h: Float32Array, pos: number): number {
    const i = Math.floor(pos);
    const f = pos - i;
    const a = h[i & this.mask] as number;
    const b = h[(i + 1) & this.mask] as number;
    return a + (b - a) * f;
  }

  private idle(): void {
    this.repeating = false;
    this.repeatIndex = 0;
    this.stopping = false;
    this.wasStop = false;
    this.release = 0;
  }
}
