import { registerKernel } from '@agstudio/sdk/worklet';
import { DuckerKernel } from './kernel';
import { DUCKER_ID, duckerParams } from './params';

registerKernel(DUCKER_ID, duckerParams, DuckerKernel);
