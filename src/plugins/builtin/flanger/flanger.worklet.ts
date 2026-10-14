import { registerKernel } from '@agstudio/sdk/worklet';
import { FlangerKernel } from './kernel';
import { FLANGER_ID, flangerParams } from './params';

registerKernel(FLANGER_ID, flangerParams, FlangerKernel);
