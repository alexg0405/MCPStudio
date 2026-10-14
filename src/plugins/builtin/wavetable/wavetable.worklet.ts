import { registerKernel } from '@agstudio/sdk/worklet';
import { WavetableKernel } from './kernel';
import { WAVETABLE_ID, wavetableParams } from './params';

registerKernel(WAVETABLE_ID, wavetableParams, WavetableKernel);
