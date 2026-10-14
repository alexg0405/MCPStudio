// Public plugin SDK entry point: `import { defineInstrument, p, GraphVoices } from '@agstudio/sdk'`.
export * from './types';
export * from './params';
export * from './dsp/math';
// Pure DSP helpers that also run on the main thread (analysis, control smoothing).
export { OnePole } from './dsp/one-pole';
export { Svf, type SvfType } from './dsp/svf';
export { EnvelopeFollower, type EnvelopeMode } from './dsp/envelope';
export { Adsr } from './dsp/adsr';
export { BlepOscillator, polyBlep, type BlepWave } from './dsp/polyblep';
export { DelayLine } from './dsp/delay-line';
export { Lfo, type LfoShape } from './dsp/lfo';
export { GraphVoices, sumSignals, type GraphVoice } from './graph-voices';
export { ParamLane } from './param-lane';
export { defineWorkletInstrument, defineWorkletEffect } from './worklet-defs';
// Instrument building blocks (M13).
export { Noise, type NoiseColor } from './dsp/noise';
export {
  WavetableBank,
  WavetableOscillator,
  addPiecewise,
  addSampled,
  WT_LEVELS,
  WT_HARMONICS,
  WT_FRAME_SIZE,
  type WavetableSpec,
} from './dsp/wavetable';
export { FmOperator, FM_ALGORITHMS, sinCycles, type FmAlgorithm } from './dsp/fm';
export { Kick, Snare, Clap, HiHat, Tom, Perc, renderDrum, softClip, type DrumModel } from './dsp/drums';
export {
  peakOverview,
  detectSlices,
  detectSlicesInto,
  gridSlicesInto,
  OVERVIEW_BUCKET,
  type SliceOptions,
} from './dsp/transients';
export { SampleReader } from './dsp/sample-reader';
