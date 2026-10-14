import { registerKernel } from '@agstudio/sdk/worklet';
import { TuneKernel } from './kernel';
import { TUNE_ID, tuneParams } from './params';

registerKernel(TUNE_ID, tuneParams, TuneKernel);
