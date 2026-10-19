import { registerKernel } from '@agstudio/sdk/worklet';
import { HarmonizerKernel } from './kernel';
import { HARMONIZER_ID, harmonizerParams } from './params';

registerKernel(HARMONIZER_ID, harmonizerParams, HarmonizerKernel);
