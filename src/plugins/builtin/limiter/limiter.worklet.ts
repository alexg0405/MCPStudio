import { registerKernel } from '@agstudio/sdk/worklet';
import { LimiterKernel } from './kernel';
import { LIMITER_ID, limiterParams } from './params';

registerKernel(LIMITER_ID, limiterParams, LimiterKernel);
