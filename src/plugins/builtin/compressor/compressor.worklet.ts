import { registerKernel } from '@agstudio/sdk/worklet';
import { CompressorKernel } from './kernel';
import { COMPRESSOR_ID, compressorParams } from './params';

registerKernel(COMPRESSOR_ID, compressorParams, CompressorKernel);
