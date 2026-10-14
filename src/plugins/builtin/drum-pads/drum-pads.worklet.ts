import { registerKernel } from '@agstudio/sdk/worklet';
import { DrumPadsKernel } from './kernel';
import { DRUM_PADS_ID, drumPadsParams } from './params';

registerKernel(DRUM_PADS_ID, drumPadsParams, DrumPadsKernel);
