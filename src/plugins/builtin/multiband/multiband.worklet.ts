import { registerKernel } from '@agstudio/sdk/worklet';
import { MultibandKernel } from './kernel';
import { MULTIBAND_ID, multibandParams } from './params';

registerKernel(MULTIBAND_ID, multibandParams, MultibandKernel);
