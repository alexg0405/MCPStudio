import { registerKernel } from '@agstudio/sdk/worklet';
import { StutterKernel } from './kernel';
import { STUTTER_ID, stutterParams } from './params';

registerKernel(STUTTER_ID, stutterParams, StutterKernel);
