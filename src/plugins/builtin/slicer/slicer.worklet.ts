import { registerKernel } from '@agstudio/sdk/worklet';
import { SlicerKernel } from './kernel';
import { SLICER_ID, slicerParams } from './params';

registerKernel(SLICER_ID, slicerParams, SlicerKernel);
