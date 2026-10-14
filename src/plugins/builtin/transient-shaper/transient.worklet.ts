import { registerKernel } from '@agstudio/sdk/worklet';
import { TransientKernel } from './kernel';
import { TRANSIENT_ID, transientParams } from './params';

registerKernel(TRANSIENT_ID, transientParams, TransientKernel);
