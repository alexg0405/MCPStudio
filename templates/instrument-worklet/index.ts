/**
 * __PLUGIN_NAME__: an instrument with custom per-sample DSP (see dsp.worklet.ts).
 * Editing dsp.worklet.ts restarts audio (~0.2 s) with the new code; editing params.ts reloads the page.
 * Guide: docs/plugin-sdk.md
 */
import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletInstrument({
  id: ID,
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'Synths',
  params,
  processor,
});
