// Audio-thread SDK: `import { InstrumentKernel, registerKernel, VoicePool } from '@agstudio/sdk/worklet'`.
export {
  InstrumentKernel,
  EffectKernel,
  at,
  type KernelHost,
  type KernelTransport,
  type ParamBlock,
  type KernelClass,
} from './kernel';
export { VoicePool, type Voice } from './voice-pool';
export { registerKernel } from './register';
export { KernelRunner } from './runner';
export { EventQueue } from './event-queue';
export * from '../dsp/math';
export { Biquad, type BiquadType } from '../dsp/biquad';
export { OnePole } from '../dsp/one-pole';
export { Svf, type SvfType } from '../dsp/svf';
export { EnvelopeFollower, type EnvelopeMode } from '../dsp/envelope';
export { Adsr } from '../dsp/adsr';
export { BlepOscillator, polyBlep, type BlepWave } from '../dsp/polyblep';
export { DelayLine } from '../dsp/delay-line';
export { Lfo, type LfoShape } from '../dsp/lfo';
export { Rng } from '../dsp/random';
export { p, type ParamSpecs } from '../params';
// Instrument building blocks (M13).
export { Noise, type NoiseColor } from '../dsp/noise';
export {
  WavetableBank,
  WavetableOscillator,
  addPiecewise,
  addSampled,
  WT_LEVELS,
  WT_HARMONICS,
  WT_FRAME_SIZE,
  type WavetableSpec,
} from '../dsp/wavetable';
export { FmOperator, FM_ALGORITHMS, sinCycles, type FmAlgorithm } from '../dsp/fm';
export { Kick, Snare, Clap, HiHat, Tom, Perc, renderDrum, softClip, type DrumModel } from '../dsp/drums';
export {
  peakOverview,
  detectSlices,
  detectSlicesInto,
  gridSlicesInto,
  OVERVIEW_BUCKET,
  type SliceOptions,
} from '../dsp/transients';
export { SampleReader } from '../dsp/sample-reader';
