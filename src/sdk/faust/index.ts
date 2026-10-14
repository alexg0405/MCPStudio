/**
 * Faust plugins: write the DSP in the Faust language (a `.dsp` file next to your plugin's index.ts)
 * and define the plugin with one call:
 *
 *   import dsp from './filter.dsp';
 *   export default defineFaustEffect({ id: 'user.my-filter', name: 'My Filter', version: 1, dsp });
 *
 * AGstudio's dev server compiles the .dsp to WebAssembly when it loads (errors show as a plugin
 * error, and edits hot-reload). Its sliders, number entries, checkboxes and buttons become the
 * plugin's knobs and switches, with their labels, ranges, [unit:Hz], [scale:log] and [tooltip:…].
 * A DSP with a `gate` control is an instrument: notes play its `freq`, `gain` and `gate`.
 */
import type { ParamSpecs } from '../params';
import type { EffectDef, InstrumentDef, Preset } from '../types';
import { faustControls, type FaustMeta } from './params';

export type { FaustMeta, FaustUiItem } from './params';

/** What importing a `.dsp` file gives you. */
export interface FaustDsp {
  /** The file's name without `.dsp`. */
  name: string;
  /** 'instrument' when the DSP has a `gate` control (Faust's polyphony convention), else 'effect'. */
  kind: 'effect' | 'instrument';
  meta: FaustMeta;
  /** The worklet module that registers this DSP's kernel. */
  processor: string;
  /** Its processor name (it changes with the code, so an edit loads as a new processor). */
  processorName: string;
}

interface FaustDefBase {
  id: string;
  name: string;
  version: number;
  category?: string;
  description?: string;
  dsp: FaustDsp;
  /** Presets by param id (the Faust controls' short names). */
  presets?: readonly Preset<ParamSpecs, undefined>[];
  /** Seconds of tail after the input stops (exports wait for it). */
  tailTime?: number;
}

/** An effect from a Faust DSP (`process` with inputs: 1 input hears both sides, 2 get one each). */
export function defineFaustEffect(def: FaustDefBase): EffectDef<ParamSpecs, undefined> {
  const { dsp, tailTime, ...rest } = def;
  if (dsp.kind !== 'effect')
    throw new Error(`${dsp.name}.dsp has a gate control, so it is an instrument: use defineFaustInstrument`);
  return {
    ...rest,
    kind: 'effect',
    params: faustControls(dsp.meta, 'effect').params,
    processor: dsp.processor,
    async create(host) {
      const port = await host.worklet({ name: dsp.processorName, numberOfInputs: 1, outputChannelCount: [2] });
      return {
        input: port.node,
        output: port.node,
        tailTime: tailTime ?? 0,
        latency: 0,
        reset: () => port.reset(),
        dispose: () => port.dispose(),
      };
    },
  };
}

/** An instrument from a Faust DSP voice (`freq`, `gain`, `gate` controls), played polyphonically. */
export function defineFaustInstrument(def: FaustDefBase): InstrumentDef<ParamSpecs, undefined> {
  const { dsp, tailTime, ...rest } = def;
  if (dsp.kind !== 'instrument')
    throw new Error(`${dsp.name}.dsp has no gate control, so it is an effect: use defineFaustEffect`);
  return {
    ...rest,
    kind: 'instrument',
    params: faustControls(dsp.meta, 'instrument').params,
    processor: dsp.processor,
    async create(host) {
      const port = await host.worklet({ name: dsp.processorName, numberOfInputs: 0, outputChannelCount: [2] });
      return {
        output: port.node,
        tailTime: tailTime ?? 1,
        noteOn: (e) => port.noteOn(e),
        noteOff: (e) => port.noteOff(e),
        allNotesOff: (time, hard) => port.allNotesOff(time, hard),
        controlChange: (cc, value, time) => port.controlChange(cc, value, time),
        dispose: () => port.dispose(),
      };
    },
  };
}

export { faustControls };
