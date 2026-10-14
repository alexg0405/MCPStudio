import { registerKernel } from '@agstudio/sdk/worklet';
import { VocoderKernel } from './kernel';
import { VOCODER_ID, vocoderParams } from './params';

registerKernel(VOCODER_ID, vocoderParams, VocoderKernel);
