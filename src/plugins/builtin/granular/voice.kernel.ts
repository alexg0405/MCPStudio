// One Granular voice: a note's cloud of grains. Everything here runs on the audio thread: the grains live in
// fixed-size arrays made when the voice is created, so spawning and rendering never allocate.
import { Adsr, pow2, Svf, type Voice } from '@agstudio/sdk/worklet';
import { ENV_LAST } from './shapes.kernel';

/** Grains one note can have sounding at once (a new grain takes the oldest when all are busy). */
export const GRAINS_PER_VOICE = 64;
/** Grains may not play faster than this many times the original speed (keeps a tiny sample from wrapping many times a sample). */
const MAX_SPEED = 64;
const MIN_SPEED = 1 / MAX_SPEED;
/** The key that plays a sample at its original pitch (C5 in FL Studio's naming). */
export const NEUTRAL_KEY = 60;

/** The audio the grains are cut from: a loaded sample, or a built-in texture. */
export interface GrainSource {
  left: Float32Array;
  right: Float32Array;
  /** Frames in each channel. */
  length: number;
  /** True when both channels are the same array (a mono file): the loop reads it once. */
  mono: boolean;
  /** Source frames per output frame at the original pitch (the file's rate over the context's rate). */
  rateRatio: number;
}

/** The sound-shaping settings a control step reads, shared by all voices (filled once per render call). */
export class GrainSettings {
  /** Where grains start, as a fraction of the sample, and how far they may wander from it. */
  position = 0;
  spray = 0;
  /** Grain length in frames, and grains started per second. */
  sizeFrames = 1;
  density = 1;
  /** Timing randomness 0–1. */
  jitter = 0;
  /** Chance 0–1 that a grain plays backwards. */
  reverse = 0;
  /** Pitch in semitones from the knobs and the channel, before the key. */
  pitchSemis = 0;
  pitchSpray = 0;
  keyTrack = 1;
  /** Stereo spread 0–1. */
  spread = 0;
  /** Each grain's volume so the cloud keeps its level whatever the density and size: 1/√(grains sounding at once). */
  grainGain = 1;
  /** Frames between grains at this density. */
  interval = 1;
  /** Filter kind (0 off, 1 low-pass, 2 high-pass), cutoff in Hz, quality factor. */
  filterKind = 0;
  cutoffHz = 20000;
  q = 0.7;
  /** Velocity sensitivity 0–1 and the overall gain. */
  velocitySense = 0;
  levelGain = 1;
}

/** A voice that fades out over `STEAL_FRAMES` when a new note needs its place (no click). */
export const STEAL_FRAMES = 256;

export class GrainVoice implements Voice {
  noteId = -1;
  key = NEUTRAL_KEY;
  active = false;
  releasing = false;
  age = 0;
  /** Set when the note arrived and it has not rendered yet. */
  fresh = false;
  velocity = 1;
  pan = 0;
  /** The note's own fine pitch in cents. */
  fine = 0;
  readonly env: Adsr;
  readonly filterLeft = new Svf();
  readonly filterRight = new Svf();
  /** The filter design in force (kind, cutoff, Q), or NaN so it is set at the next chance. */
  private filterKind = NaN;
  private filterCutoff = NaN;
  private filterQ = NaN;
  /** The scan offset (a fraction of the sample) the note has moved by, and the last one used (held by Freeze). */
  scanOffset = 0;
  heldOffset = 0;
  /** Frames until the next grain (relative to the start of the chunk being rendered). */
  countdown = 0;
  /** Frames left of the fade-out that makes way for a new note (0 = not fading). */
  fadeLeft = 0;
  private randomState = 1;

  // The grains, as parallel arrays (a "structure of arrays": no objects to allocate).
  readonly isActive = new Uint8Array(GRAINS_PER_VOICE);
  /** Frames to wait before the grain starts, within the chunk it was made in. */
  readonly delay = new Float64Array(GRAINS_PER_VOICE);
  /** Read position in the source (frames) and its step per output frame (negative: backwards). */
  readonly position = new Float64Array(GRAINS_PER_VOICE);
  readonly step = new Float64Array(GRAINS_PER_VOICE);
  /** Position in the fade table and its step per frame. */
  readonly fade = new Float64Array(GRAINS_PER_VOICE);
  readonly fadeStep = new Float64Array(GRAINS_PER_VOICE);
  readonly gainLeft = new Float64Array(GRAINS_PER_VOICE);
  readonly gainRight = new Float64Array(GRAINS_PER_VOICE);
  readonly pan01 = new Float64Array(GRAINS_PER_VOICE);

  constructor(controlRate: number) {
    this.env = new Adsr(controlRate);
  }

  /** Restarts the voice's random sequence (deterministic: the same seed and note count give the same grains). */
  seedRandom(seed: number): void {
    this.randomState = seed >>> 0;
  }

  /** Uniform random number in [0, 1) (mulberry32, as the SDK's `Rng`). */
  random(): number {
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let t = this.randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  clearGrains(): void {
    this.isActive.fill(0);
  }

  get grainCount(): number {
    let n = 0;
    for (let g = 0; g < GRAINS_PER_VOICE; g++) n += this.isActive[g] as number;
    return n;
  }

  /**
   * Starts a grain `delay` frames into the chunk: it takes a free slot, or the slot of the grain that is furthest
   * along. Returns the source position it starts at, as a fraction of the sample (for tests and the editor).
   */
  spawn(s: GrainSettings, source: GrainSource, offset: number, delay: number, channelCents: number): number {
    let slot = -1;
    let furthest = -1;
    let furthestSlot = 0;
    for (let g = 0; g < GRAINS_PER_VOICE; g++) {
      if (this.isActive[g] === 0) {
        slot = g;
        break;
      }
      if ((this.fade[g] as number) > furthest) {
        furthest = this.fade[g] as number;
        furthestSlot = g;
      }
    }
    if (slot < 0) slot = furthestSlot;
    // Four draws per grain in a fixed order, whatever the settings, so a change to one knob doesn't reshuffle the rest.
    const rPosition = this.random();
    const rPitch = this.random();
    const rPan = this.random();
    const rReverse = this.random();

    let where = s.position + offset + s.spray * (2 * rPosition - 1);
    where -= Math.floor(where);
    const semitones =
      s.pitchSemis +
      s.keyTrack * (this.key - NEUTRAL_KEY) +
      (this.fine + channelCents) / 100 +
      s.pitchSpray * (2 * rPitch - 1);
    const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, pow2(semitones / 12) * source.rateRatio));
    const backwards = rReverse < s.reverse;
    const start = where * source.length;
    // A backwards grain plays the same stretch of the sample from its far end.
    let from = backwards ? start + s.sizeFrames * speed : start;
    from %= source.length;
    const pan = Math.max(-1, Math.min(1, this.pan + s.spread * (2 * rPan - 1)));

    this.isActive[slot] = 1;
    this.delay[slot] = delay;
    this.position[slot] = from;
    this.step[slot] = backwards ? -speed : speed;
    this.fade[slot] = 0;
    this.fadeStep[slot] = ENV_LAST / s.sizeFrames;
    this.gainLeft[slot] = Math.sqrt(0.5 * (1 - pan)) * s.grainGain;
    this.gainRight[slot] = Math.sqrt(0.5 * (1 + pan)) * s.grainGain;
    this.pan01[slot] = pan;
    return where;
  }

  /**
   * Adds every active grain's next `count` frames into `left` and `right` (which the caller zeroed). A grain reads
   * the source in a loop (past the end it continues at the start), so any position and speed is safe.
   */
  renderGrains(count: number, source: GrainSource, table: Float32Array, left: Float32Array, right: Float32Array): void {
    const srcL = source.left;
    const srcR = source.right;
    const length = source.length;
    const mono = source.mono;
    for (let g = 0; g < GRAINS_PER_VOICE; g++) {
      if (this.isActive[g] === 0) continue;
      const wait = this.delay[g] as number;
      if (wait >= count) {
        this.delay[g] = wait - count;
        continue;
      }
      this.delay[g] = 0;
      let x = this.position[g] as number;
      const step = this.step[g] as number;
      let e = this.fade[g] as number;
      const eStep = this.fadeStep[g] as number;
      const gl = this.gainLeft[g] as number;
      const gr = this.gainRight[g] as number;
      for (let n = wait | 0; n < count; n++) {
        if (e >= ENV_LAST) {
          this.isActive[g] = 0;
          break;
        }
        const ei = e | 0;
        const w0 = table[ei] as number;
        const w = w0 + ((table[ei + 1] as number) - w0) * (e - ei);
        const i = x | 0;
        const f = x - i;
        const j = i + 1 >= length ? 0 : i + 1;
        const a = srcL[i] as number;
        const l = a + ((srcL[j] as number) - a) * f;
        let r = l;
        if (!mono) {
          const b = srcR[i] as number;
          r = b + ((srcR[j] as number) - b) * f;
        }
        left[n] = (left[n] as number) + l * w * gl;
        right[n] = (right[n] as number) + r * w * gr;
        x += step;
        if (x >= length) {
          x -= length;
          if (x >= length) x %= length;
        } else if (x < 0) {
          x += length;
          if (x < 0) x = ((x % length) + length) % length;
        }
        e += eStep;
      }
      this.position[g] = x;
      this.fade[g] = e;
    }
  }

  /** Sets the filter's design when its kind, cutoff or quality changed (the two sides share one design). */
  setFilter(s: GrainSettings, sampleRate: number): void {
    if (s.filterKind === this.filterKind && s.cutoffHz === this.filterCutoff && s.q === this.filterQ) return;
    this.filterKind = s.filterKind;
    this.filterCutoff = s.cutoffHz;
    this.filterQ = s.q;
    if (s.filterKind === 0) return;
    this.filterLeft.set(s.filterKind === 1 ? 'lowpass' : 'highpass', s.cutoffHz, s.q, sampleRate);
    this.filterRight.copyDesign(this.filterLeft);
  }

  /** Forgets the filter so the next note starts from a clean state. */
  resetFilter(): void {
    this.filterLeft.reset();
    this.filterRight.reset();
    this.filterKind = NaN;
  }
}
