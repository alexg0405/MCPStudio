/**
 * The audio-thread side of Faust plugins: runs the DSP's compiled WebAssembly inside an SDK kernel,
 * so Faust plugins get what every AGstudio kernel gets (frame-exact notes, param automation, the
 * channel pitch, NaN guards, deterministic offline renders).
 *
 * Effects run one DSP instance (`effect.ts`). Instruments run a pool of voices, one instance each
 * (`instrument.ts`). Both are built on `FaustInstance` (`instance.ts`), which owns the wasm memory.
 */
import { registerKernel } from '../worklet/register';
import { decodeBase64 } from './base64';
import { faustEffectClass } from './effect';
import { faustInstrumentClass } from './instrument';
import { faustControls, type FaustMeta } from './params';

export { decodeBase64 } from './base64';
export { FaustInstance } from './instance';

/** How many voices an instrument gets when the generated worklet module does not say. */
const DEFAULT_VOICES = 8;

/**
 * Registers the kernel for one compiled DSP under `name` (the Vite plugin's worklet module for a
 * .dsp file calls this). `kind` 'instrument' gets a voice pool of `voices` instances.
 */
export function registerFaustKernel(
  name: string,
  meta: FaustMeta,
  wasmBase64: string,
  kind: 'effect' | 'instrument',
  voices = DEFAULT_VOICES,
): void {
  const module = new WebAssembly.Module(decodeBase64(wasmBase64) as Uint8Array<ArrayBuffer>);
  const { params, controls, voice } = faustControls(meta, kind);
  const Kernel =
    kind === 'instrument' ? faustInstrumentClass(module, meta, controls, voice, voices) : faustEffectClass(module, meta, controls);
  registerKernel(name, params, Kernel);
}
