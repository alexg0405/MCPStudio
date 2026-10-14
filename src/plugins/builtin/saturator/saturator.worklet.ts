import { registerKernel } from '@agstudio/sdk/worklet';
import { SaturatorKernel } from './kernel';
import { SATURATOR_ID, saturatorParams } from './params';

registerKernel(SATURATOR_ID, saturatorParams, SaturatorKernel);
