import { registerKernel } from '@agstudio/sdk/worklet';
import { FmKernel } from './kernel';
import { FM_ID, fmParams } from './params';

registerKernel(FM_ID, fmParams, FmKernel);
