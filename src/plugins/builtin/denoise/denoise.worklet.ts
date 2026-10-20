import { registerKernel } from '@agstudio/sdk/worklet';
import { DenoiseKernel } from './kernel';
import { DENOISE_ID, denoiseParams } from './params';

registerKernel(DENOISE_ID, denoiseParams, DenoiseKernel);
