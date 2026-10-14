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
