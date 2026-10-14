import { registerKernel } from '@agstudio/sdk/worklet';
import { DrumSynthKernel } from './kernel';
import { DRUM_SYNTH_ID, drumSynthParams } from './params';

registerKernel(DRUM_SYNTH_ID, drumSynthParams, DrumSynthKernel);
