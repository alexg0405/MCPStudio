import { registerKernel } from '@agstudio/sdk/worklet';
import { EqProKernel } from './kernel';
import { EQ_PRO_ID, eqProParams } from './params';

registerKernel(EQ_PRO_ID, eqProParams, EqProKernel);
