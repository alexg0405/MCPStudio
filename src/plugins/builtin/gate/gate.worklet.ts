import { registerKernel } from '@agstudio/sdk/worklet';
import { GateKernel } from './kernel';
import { GATE_ID, gateParams } from './params';

registerKernel(GATE_ID, gateParams, GateKernel);
