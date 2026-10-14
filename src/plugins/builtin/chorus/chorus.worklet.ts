import { registerKernel } from '@agstudio/sdk/worklet';
import { ChorusKernel } from './kernel';
import { CHORUS_ID, chorusParams } from './params';

registerKernel(CHORUS_ID, chorusParams, ChorusKernel);
