import { registerKernel } from '@agstudio/sdk/worklet';
import { StereoKernel } from './kernel';
import { STEREO_ID, stereoParams } from './params';

registerKernel(STEREO_ID, stereoParams, StereoKernel);
