import { defineWorkletInstrument } from '@agstudio/sdk';
import { EMPTY_TABLE_STATE, readUserTableState, type UserTableState } from '@agstudio/sdk/dsp/wavetable-frames';
import { lazyUi } from '@agstudio/sdk/ui';
import processor from './wavetable.worklet.ts?worker&url';
import { WAVETABLE_ID, wavetableParams } from './params';
import { WAVETABLE_PRESETS } from './presets';
import { syncUserTable } from './table-sync';
import { factoryBank } from './tables';

/**
 * Wavetable: two morphing wavetable oscillators and a full modulation section. The factory tables are
 * built once on the main thread (tables.ts) and handed to every kernel in `setup` (shared memory
 * when the page is cross-origin isolated, a copy otherwise). Each instance also has a table of its own,
 * "My table": drawn, imported or sliced from a sample in the table editor, stored compactly in the
 * plugin's state (`wavetable-frames.ts` in the SDK) and turned into a band-limited bank on the main
 * thread (`onState`), so it never aliases and costs the audio thread nothing extra.
 */
export default defineWorkletInstrument<typeof wavetableParams, UserTableState>({
  id: WAVETABLE_ID,
  name: 'Wavetable',
  version: 2,
  category: 'Synths',
  description:
    'Wavetable synth: two morphing oscillators (10 tables, plus one you draw, import or slice from a sample) with unison, sub and noise, a filter, two envelopes, two tempo-syncable LFOs and a 6-slot mod matrix, for pads, leads, basses and evolving sounds.',
  params: wavetableParams,
  processor,
  defaultState: EMPTY_TABLE_STATE,
  // Version 1 had no state: its projects and presets get an empty table. Anything else that is not a valid table
  // state becomes empty too, so a damaged project still opens.
  migrate: ({ params, state }) => ({ params, state: readUserTableState(state) }),
  onState: syncUserTable,

  // At least 4 s; longer when the amp release is (it reaches −60 dB at its time, −100 dB at 1.7×).
  tailTime: (v) => Math.max(4, 1.7 * Number(v.ampRelease)),
  ui: lazyUi(() => import('./ui').then((m) => m.WavetableUI)),
  setup(port) {
    const bank = factoryBank();
    port.send({ type: 'bank', data: bank.data, tables: bank.tables, frames: bank.frames });
  },
  presets: WAVETABLE_PRESETS,
});
