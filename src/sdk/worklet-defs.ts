/**
 * Plugins whose DSP runs in an AudioWorklet kernel. The plugin file passes the processor URL; the
 * kernel lives in a `*.worklet.ts` file that calls registerKernel(sameId, params, Kernel).
 */
import type { ParamSpecs } from './params';
import type { EffectDef, InstrumentDef, PluginHost, WorkletPort } from './types';

type WorkletInstrumentDef<P extends ParamSpecs, S> = Omit<InstrumentDef<P, S>, 'kind' | 'create'> & {
  processor: string;
  /** Seconds of release tail after the last note (export padding). Default 1. */
  tailTime?: number;
};

type WorkletEffectDef<P extends ParamSpecs, S> = Omit<EffectDef<P, S>, 'kind' | 'create'> & {
  processor: string;
  tailTime?: number;
  latency?: number;
};

/** Keeps the processor's copy of every declared sample slot up to date. */
function forwardSamples(host: PluginHost<ParamSpecs, unknown>, port: WorkletPort, slots: readonly string[] = []) {
  const offs = slots.map((slot) => {
    const send = (b: AudioBuffer | null) => port.sendSample(slot, b);
    const now = host.samples.get(slot);
    if (now) send(now);
    else void host.samples.load(slot).then((b) => b && send(b));
    return host.samples.onChange(slot, send);
  });
  return () => offs.forEach((off) => off());
}

export function defineWorkletInstrument<const P extends ParamSpecs, S = undefined>(
  def: WorkletInstrumentDef<P, S>,
): InstrumentDef<P, S> {
  return {
    ...def,
    kind: 'instrument',
    async create(host) {
      const port = await host.worklet({ numberOfInputs: 0, outputChannelCount: [2] });
      const stopSamples = forwardSamples(host as PluginHost<ParamSpecs, unknown>, port, def.sampleSlots);
      return {
        output: port.node,
        tailTime: def.tailTime ?? 1,
        noteOn: (e) => port.noteOn(e),
        noteOff: (e) => port.noteOff(e),
        allNotesOff: (time, hard) => port.allNotesOff(time, hard),
        setState: (state) => port.setState(state),
        dispose: () => {
          stopSamples();
          port.dispose();
        },
      };
    },
  };
}

export function defineWorkletEffect<const P extends ParamSpecs, S = undefined>(
  def: WorkletEffectDef<P, S>,
): EffectDef<P, S> {
  return {
    ...def,
    kind: 'effect',
    async create(host) {
      const port = await host.worklet({ numberOfInputs: 1, outputChannelCount: [2] });
      const stopSamples = forwardSamples(host as PluginHost<ParamSpecs, unknown>, port, def.sampleSlots);
      return {
        input: port.node,
        output: port.node,
        tailTime: def.tailTime ?? 0,
        latency: def.latency ?? 0,
        setState: (state) => port.setState(state),
        reset: () => port.reset(),
        dispose: () => {
          stopSamples();
          port.dispose();
        },
      };
    },
  };
}
