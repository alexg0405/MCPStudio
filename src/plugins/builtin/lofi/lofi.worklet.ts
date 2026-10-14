import { registerKernel } from '@agstudio/sdk/worklet';
import { LofiKernel } from './kernel';
import { LOFI_ID, lofiParams } from './params';

registerKernel(LOFI_ID, lofiParams, LofiKernel);
