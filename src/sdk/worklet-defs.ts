/**
 * Plugins whose DSP runs in an AudioWorklet kernel. The plugin file passes the processor URL; the
 * kernel lives in a `*.worklet.ts` file that calls registerKernel(sameId, params, Kernel).
 */
import type { ParamSpecs } from './params';
import type { EffectDef, InstrumentDef, PluginHost, TapOptions, WorkletPort } from './types';

/**
 * Runs on the main thread once the processor exists, before any note or audio reaches it: send the
 * kernel data that is too heavy to build on the audio thread (`port.send`, received by the kernel's
 * `onMessage`), e.g. wavetables or rendered sounds. It may return a cleanup function for dispose.
 */
type WorkletSetup<P extends ParamSpecs, S> = (port: WorkletPort, host: PluginHost<P, S>) => void | (() => void);

type WorkletInstrumentDef<P extends ParamSpecs, S> = Omit<InstrumentDef<P, S>, 'kind' | 'create'> & {
  processor: string;
  /** Seconds of release tail after the last note (export padding). Default 1. */
  tailTime?: number;
  setup?: WorkletSetup<P, S>;
  /**
   * Show the processor's output in the editor (`PluginUIProps.tap`); messages the kernel posts as
   * `{ readings: { name: value } }` (the `Readings` helper) become the tap's readings.
   */
  tap?: boolean | TapOptions;
};

type WorkletEffectDef<P extends ParamSpecs, S> = Omit<EffectDef<P, S>, 'kind' | 'create'> & {
  processor: string;
  tailTime?: number;
  /**
   * Seconds the effect delays its audio (a look-ahead): the host compensates it. A function gets the
   * sample rate, for latencies that are a whole number of frames: `(sr) => 64 / sr`.
   */
  latency?: number | ((sampleRate: number) => number);
  setup?: WorkletSetup<P, S>;
  /** See the instrument option: the editor sees the effect's output and the kernel's readings. */
  tap?: boolean | TapOptions;
};

/** Taps the processor's output for the editor and forwards the kernel's `{ readings }` posts. */
function tapPort(host: PluginHost<ParamSpecs, unknown>, port: WorkletPort, tap: boolean | TapOptions | undefined) {
  if (!tap || !host.tap) return () => {};
  const t = host.tap(port.node, tap === true ? undefined : tap);
  return port.onMessage((msg) => {
    const readings = (msg as { readings?: unknown } | null)?.readings;
    if (readings && typeof readings === 'object') t.publish(readings as Record<string, number>);
  });
}

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
      const cleanup = def.setup?.(port, host);
      const stopSamples = forwardSamples(host as PluginHost<ParamSpecs, unknown>, port, def.sampleSlots);
      const stopTap = tapPort(host as PluginHost<ParamSpecs, unknown>, port, def.tap);
      return {
        output: port.node,
        tailTime: def.tailTime ?? 1,
        noteOn: (e) => port.noteOn(e),
        noteOff: (e) => port.noteOff(e),
        allNotesOff: (time, hard) => port.allNotesOff(time, hard),
        controlChange: (cc, value, time) => port.controlChange(cc, value, time),
        setState: (state) => port.setState(state),
        dispose: () => {
          stopSamples();
          cleanup?.();
          stopTap();
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
      const port = await host.worklet({ numberOfInputs: def.sidechain ? 2 : 1, outputChannelCount: [2] });
      const cleanup = def.setup?.(port, host);
      const stopSamples = forwardSamples(host as PluginHost<ParamSpecs, unknown>, port, def.sampleSlots);
      // The sidechain reaches the kernel as the node's second input.
      if (def.sidechain && host.sidechain) host.sidechain.connect(port.node, 0, 1);
      const stopTap = tapPort(host as PluginHost<ParamSpecs, unknown>, port, def.tap);
      const latency = typeof def.latency === 'function' ? def.latency(host.audioContext.sampleRate) : def.latency;
      return {
        input: port.node,
        output: port.node,
        tailTime: def.tailTime ?? 0,
        latency: latency ?? 0,
        setState: (state) => port.setState(state),
        reset: () => port.reset(),
        dispose: () => {
          stopSamples();
          cleanup?.();
          stopTap();
          port.dispose();
        },
      };
    },
  };
}
