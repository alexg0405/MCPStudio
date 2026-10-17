import { registerKernel } from '@agstudio/sdk/worklet';
import { DeEsserKernel } from './kernel';
import { DE_ESSER_ID, deEsserParams } from './params';

registerKernel(DE_ESSER_ID, deEsserParams, DeEsserKernel);
