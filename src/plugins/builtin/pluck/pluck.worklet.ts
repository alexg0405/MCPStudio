import { registerKernel } from '@agstudio/sdk/worklet';
import { PluckKernel } from './kernel';
import { PLUCK_ID, pluckParams } from './params';

registerKernel(PLUCK_ID, pluckParams, PluckKernel);
