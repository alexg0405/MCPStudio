import { registerKernel } from '@agstudio/sdk/worklet';
import { PhaserKernel } from './kernel';
import { PHASER_ID, phaserParams } from './params';

registerKernel(PHASER_ID, phaserParams, PhaserKernel);
