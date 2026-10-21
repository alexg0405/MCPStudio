// Runs on the audio thread. The DSP itself is in kernel.ts (so it can be tested in Node).
import { registerKernel } from '@agstudio/sdk/worklet';
import { BitCrusherKernel } from './kernel';
import { ID, params } from './params';

registerKernel(ID, params, BitCrusherKernel);
