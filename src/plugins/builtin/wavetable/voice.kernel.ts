import { Adsr, Lfo, Noise, Svf, type Voice } from '@agstudio/sdk/worklet';

/** The most unison copies one oscillator plays at once. */
export const MAX_UNISON = 8;

const NO_DATA = new Float32Array(1);

/** One oscillator of one voice: where it reads its table, its unison phases and its unison levels. */
export class OscillatorState {
  /** The bank data its frames are read from (the factory bank, or the user table's). */
  data: Float32Array = NO_DATA;
  /** Each unison copy's position in the cycle (0 to 1) and how far it advances per sample. */
  readonly phase = new Float64Array(MAX_UNISON);
  readonly phaseStep = new Float64Array(MAX_UNISON);
  /** Each unison copy's gain into the left and right channel. */
  readonly gainLeft = new Float64Array(MAX_UNISON);
  readonly gainRight = new Float64Array(MAX_UNISON);
  isOn = false;
  /**
   * Where in `data` the two frames being morphed start (at the current mip level), how many samples a cycle
   * has at that level, and how far the morph is from the first frame to the second (0 to 1).
   */
  frameAOffset = 0;
  frameBOffset = 0;
  cycleSize = 256;
  /** Identifies the frame pair and mip level now loaded, so a change is noticed (-1: nothing loaded yet). */
  frameKey = -1;
  morph = 0;
  /** How much the morph moves per sample while it glides to a new position. */
  morphStep = 0;
}

/** Everything one note needs to sound: envelopes, LFOs, oscillators, sub, noise, filters and level. */
export class WavetableVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  /** Set up at its first rendered frame (with that block's params). */
  needsSetUp = false;
  velocity = 1;
  notePan = 0;
  /** The note's own fine tuning, in cents. */
  fineCents = 0;
  /** Pitch in semitones, gliding from `glideFrom` to `key` over `glideSteps` control steps. */
  pitch = 60;
  glideFrom = 60;
  glideSteps = 0;
  glideStep = 0;
  readonly ampEnv: Adsr;
  readonly modEnv: Adsr;
  readonly lfo1: Lfo;
  readonly lfo2: Lfo;
  lfo1Value = 0;
  lfo2Value = 0;
  /** How much the mod matrix speeds each LFO up (1 = not at all). */
  lfo1RateFactor = 1;
  lfo2RateFactor = 1;
  readonly osc1 = new OscillatorState();
  readonly osc2 = new OscillatorState();
  unison = 1;
  subPhase = 0;
  subPhaseStep = 0;
  subGain = 0;
  noiseGain = 0;
  /** One-pole low-pass coefficient and state that colour the noise. */
  noiseCoefficient = 1;
  noiseState = 0;
  readonly noise: Noise;
  /** The filter, per channel. Stage 2 only runs for the steep (24 dB) low-pass. */
  readonly stage1Left = new Svf();
  readonly stage1Right = new Svf();
  readonly stage2Left = new Svf();
  readonly stage2Right = new Svf();
  /** Input gain of the soft clipper before the filter (0 = clipper off), and the gain that levels it again. */
  drive = 0;
  driveMakeup = 1;
  /** The filter design in force (type, cutoff and Q), or NaN when it must be set again. */
  filterType = NaN;
  filterCutoff = NaN;
  filterQ = NaN;
  /** Output level, gliding by `gainStep` per sample, and the pan gains. */
  gain = 0;
  gainStep = 0;
  panLeft = 1;
  panRight = 1;
  /** Samples left until the next control step. */
  countdown = 0;

  constructor(controlRate: number, noiseSeed: number) {
    this.ampEnv = new Adsr(controlRate);
    this.modEnv = new Adsr(controlRate);
    this.lfo1 = new Lfo(controlRate, 1);
    this.lfo2 = new Lfo(controlRate, 2);
    this.noise = new Noise(noiseSeed);
  }
}
