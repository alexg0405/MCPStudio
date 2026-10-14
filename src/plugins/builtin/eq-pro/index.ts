import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './eq-pro.worklet.ts?worker&url';
import { EqProUI } from './EqProUI';
import { EQ_PRO_ID, eqProParams } from './params';

/**
 * Eight-band parametric EQ with a drawn response curve, a live spectrum of its output and
 * draggable band handles (drag: frequency and gain, scroll: Q, double-click: on/off).
 */
export default defineWorkletEffect({
  id: EQ_PRO_ID,
  name: 'EQ Pro',
  version: 1,
  category: 'EQ',
  description:
    'Shapes the tone with up to eight bands (bells, shelves, cuts and notches) on a curve you drag, over a live spectrum.',
  params: eqProParams,
  processor,
  ui: EqProUI,
  tap: { fftSize: 4096, smoothing: 0.8 },
  presets: [
    {
      name: 'Vocal air',
      params: {
        b1On: true,
        b1Type: 'lowCut24',
        b1Freq: 90,
        b5On: true,
        b5Freq: 3000,
        b5Gain: 2,
        b5Q: 1,
        b7On: true,
        b7Freq: 10000,
        b7Gain: 3.5,
      },
    },
    {
      name: 'Kick and snare punch',
      params: {
        b1On: true,
        b1Type: 'lowCut24',
        b1Freq: 30,
        b2On: true,
        b2Freq: 70,
        b2Gain: 3,
        b3On: true,
        b3Freq: 400,
        b3Gain: -4,
        b3Q: 1.2,
        b6On: true,
        b6Freq: 4500,
        b6Gain: 3,
        b6Q: 1,
      },
    },
    {
      name: 'Clean up the low end',
      params: { b1On: true, b1Type: 'lowCut48', b1Freq: 40, b3On: true, b3Freq: 250, b3Gain: -3, b3Q: 1.4 },
    },
    { name: 'Mud cut (300 Hz)', params: { b3On: true, b3Freq: 300, b3Gain: -5, b3Q: 1.4 } },
    {
      name: 'Bright master',
      params: { b1On: true, b1Type: 'lowCut12', b1Freq: 25, b7On: true, b7Freq: 12000, b7Gain: 2.5 },
    },
    {
      name: 'Telephone',
      params: {
        b1On: true,
        b1Type: 'lowCut24',
        b1Freq: 400,
        b5On: true,
        b5Freq: 1500,
        b5Gain: 6,
        b5Q: 0.8,
        b8On: true,
        b8Type: 'highCut24',
        b8Freq: 3000,
      },
    },
    {
      name: 'Dark and warm',
      params: { b2On: true, b2Freq: 120, b2Gain: 2, b8On: true, b8Type: 'highCut12', b8Freq: 6000 },
    },
    { name: 'Hum notch (60 Hz)', params: { b2On: true, b2Type: 'notch', b2Freq: 60, b2Q: 8 } },
  ],
});
