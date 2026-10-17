import { registerKernel } from '@agstudio/sdk/worklet';
import { DoublerKernel } from './kernel';
import { DOUBLER_ID, doublerParams } from './params';

registerKernel(DOUBLER_ID, doublerParams, DoublerKernel);
