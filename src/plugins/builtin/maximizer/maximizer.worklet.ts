import { registerKernel } from '@agstudio/sdk/worklet';
import { MaximizerKernel } from './kernel';
import { MAXIMIZER_ID, maximizerParams } from './params';

registerKernel(MAXIMIZER_ID, maximizerParams, MaximizerKernel);
