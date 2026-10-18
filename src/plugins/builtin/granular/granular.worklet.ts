import { registerKernel } from '@agstudio/sdk/worklet';
import { GranularKernel } from './kernel';
import { GRANULAR_ID, granularParams } from './params';

registerKernel(GRANULAR_ID, granularParams, GranularKernel);
