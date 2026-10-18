/**
 * Plugins whose DSP runs in an AudioWorklet kernel. The plugin file passes the processor URL; the
 * kernel lives in a `*.worklet.ts` file that calls registerKernel(sameId, params, Kernel).
 */
import type { ParamSpecs, ParamValues } from './params';
import type { EffectDef, InstrumentDef, PluginHost, TapOptions, WorkletPort } from './types';

/**
 * Runs on the main thread once the processor exists, before any note or audio reaches it: send the
 * kernel data that is too heavy to build on the audio thread (`port.send`, received by the kernel's
 * `onMessage`), e.g. wavetables or rendered sounds. It may return a cleanup function for dispose.
 */
type WorkletSetup<P extends ParamSpecs, S> = (port: WorkletPort, host: PluginHost<P, S>) => void | (() => void);

/**
 * Runs on the main thread with the plugin's state when the instance is made (before any note) and again every time the
 * state changes (an edit, undo, a preset, a project load): turn the state into something the kernel needs and send it
 * (`port.send`). For data derived from the state that is too heavy for the audio thread, such as a drawn wavetable's
 * band-limited mip levels. Keep it quick: it runs inside the edit.
 */
type WorkletStateHook<P extends ParamSpecs, S> = (state: S, port: WorkletPort, host: PluginHost<P, S>) => void;

type WorkletInstrumentDef<P extends ParamSpecs, S> = Omit<InstrumentDef<P, S>, 'kind' | 'create'> & {
  processor: string;
  /**
   * Seconds of release tail after the last note (export padding). Default 1. A function gets the
   * params' current values, for a tail that follows a release knob: `(v) => Math.max(1, v.release)`, and the
   * host, for a tail that follows the loaded samples (`host.samples.durationSec('main')`) or the notes played
   * (`host.channel?.lowestKey`): the export asks before any audio is decoded.
   */
  tailTime?: number | ((values: ParamValues<P>, host: PluginHost<P, S>) => number);
  setup?: WorkletSetup<P, S>;
  onState?: WorkletStateHook<P, S>;
  /**
   * Show the processor's output in the editor (`PluginUIProps.tap`); messages the kernel posts as
   * `{ readings: { name: value } }` (the `Readings` helper) become the tap's readings.
   */
  tap?: boolean | TapOptions;
};

type WorkletEffectDef<P extends ParamSpecs, S> = Omit<EffectDef<P, S>, 'kind' | 'create'> & {
  processor: string;
  /**
   * Seconds the effect keeps sounding after its input stops. Default 0. A function gets the params' current
   * values and the host (`host.samples.durationSec('ir')` for a tail that follows a loaded sample).
   */
  tailTime?: number | ((values: ParamValues<P>, host: PluginHost<P, S>) => number);
  /**
   * Seconds the effect delays its audio (a look-ahead): the host compensates it. A function gets the
   * sample rate, for latencies that are a whole number of frames: `(sr) => 64 / sr`.
   */
  latency?: number | ((sampleRate: number) => number);
  setup?: WorkletSetup<P, S>;
  /** See the instrument option: the editor sees the effect's output and the kernel's readings. */
  tap?: boolean | TapOptions;
};

/** The params' current values, for `tailTime` functions. */
function currentValues<P extends ParamSpecs>(host: PluginHost<P, unknown>): ParamValues<P> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(host.params)) out[key] = (host.params as Record<string, { value: unknown }>)[key]?.value;
  return out as ParamValues<P>;
}

/** Resolves a `tailTime` option (a number, or a function of the current param values and the host). */
function tailOf<P extends ParamSpecs, S>(
  tail: number | ((values: ParamValues<P>, host: PluginHost<P, S>) => number) | undefined,
  host: PluginHost<P, S>,
  fallback: number,
): number {
  if (typeof tail === 'function') {
    const t = tail(currentValues(host), host);
    return Number.isFinite(t) && t >= 0 ? t : fallback;
  }
  return tail ?? fallback;
}

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

/**
 * Effects with `notes: { param }`: sends the notes of the instrument channel the (int) param names to the
 * kernel, following the param (0 = none, 1 = the first instrument channel, …). Everything held is released
 * when the channel changes.
 */
function followNotes(host: PluginHost<ParamSpecs, unknown>, port: WorkletPort, param: string | undefined): () => void {
  const feed = host.notes;
  const handle = param
    ? (host.params as unknown as Record<string, { value: unknown; onChange(cb: (v: unknown, t: number) => void): () => void } | undefined>)[param]
    : undefined;
  if (!feed || !handle) return () => {};
  let stop: () => void = () => {};
  const bind = (value: unknown, time = host.audioContext.currentTime) => {
    stop();
    port.allNotesOff(time, true);
    const position = Math.round(Number(value));
    stop =
      position >= 1
        ? feed.listen(position, (e) => {
            if (e.kind === 'on') port.noteOn({ time: e.time, noteId: e.noteId, key: e.key, velocity: e.velocity });
            else if (e.kind === 'off') port.noteOff({ time: e.time, noteId: e.noteId, key: e.key, release: e.velocity });
            else port.allNotesOff(e.time, false);
          })
        : () => {};
  };
  bind(handle.value);
  const off = handle.onChange((v, t) => bind(v, t));
  return () => {
    off();
    stop();
  };
}

/** Declares an instrument whose DSP runs in an AudioWorklet kernel (registered with `registerKernel` in the `processor` file). */
export function defineWorkletInstrument<const P extends ParamSpecs, S = undefined>(
  def: WorkletInstrumentDef<P, S>,
): InstrumentDef<P, S> {
  return {
    ...def,
    kind: 'instrument',
    async create(host) {
      const port = await host.worklet({ numberOfInputs: 0, outputChannelCount: [2] });
      const cleanup = def.setup?.(port, host);
      def.onState?.(host.state, port, host);
      const stopSamples = forwardSamples(host as PluginHost<ParamSpecs, unknown>, port, def.sampleSlots);
      const stopTap = tapPort(host as PluginHost<ParamSpecs, unknown>, port, def.tap);
      return {
        output: port.node,
        get tailTime() {
          return tailOf(def.tailTime, host, 1);
        },
        noteOn: (e) => port.noteOn(e),
        noteOff: (e) => port.noteOff(e),
        allNotesOff: (time, hard) => port.allNotesOff(time, hard),
        controlChange: (cc, value, time) => port.controlChange(cc, value, time),
        setState: (state) => {
          port.setState(state);
          def.onState?.(state as S, port, host);
        },
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

/** Declares an effect whose DSP runs in an AudioWorklet kernel (registered with `registerKernel` in the `processor` file). */
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
      const stopNotes = followNotes(host as PluginHost<ParamSpecs, unknown>, port, def.notes?.param);
      const latency = typeof def.latency === 'function' ? def.latency(host.audioContext.sampleRate) : def.latency;
      return {
        input: port.node,
        output: port.node,
        get tailTime() {
          return tailOf(def.tailTime, host, 0);
        },
        latency: latency ?? 0,
        setState: (state) => port.setState(state),
        reset: () => port.reset(),
        dispose: () => {
          stopSamples();
          stopNotes();
          cleanup?.();
          stopTap();
          port.dispose();
        },
      };
    },
  };
}
