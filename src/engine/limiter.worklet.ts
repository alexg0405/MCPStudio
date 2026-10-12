import { registerKernel } from '@agstudio/sdk/worklet';
import { LIMITER_ID, limiterParams, SafetyLimiterKernel } from './limiter-kernel';

registerKernel(LIMITER_ID, limiterParams, SafetyLimiterKernel);
