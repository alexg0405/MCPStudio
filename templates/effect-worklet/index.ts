/**
 * __PLUGIN_NAME__: an effect with custom per-sample DSP (see dsp.worklet.ts).
 * Guide: docs/plugin-sdk.md
 */
import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletEffect({
  id: ID,
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'Distortion',
  params,
  processor,
});
