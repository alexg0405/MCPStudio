import { registerKernel } from '@agstudio/sdk/worklet';
import { ReverbKernel } from './kernel';
import { REVERB_ID, reverbParams } from './params';

registerKernel(REVERB_ID, reverbParams, ReverbKernel);
