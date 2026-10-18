/** Plugin definitions: what a plugin file exports, and the helpers that build them. */
import type { ParamSpecs, ValueOf } from '../params';
import type { PluginUIComponent, PluginMeter, PluginUIProps } from './editor';
import type { PluginHost } from './host';
import type { EffectInstance, InstrumentInstance } from './instances';

/** A named set of param values (and state) the user can pick. Params it leaves out keep their defaults. */
export interface Preset<P extends ParamSpecs, S> {
  name: string;
  params?: Partial<{ [K in keyof P]: ValueOf<P[K]> }>;
  state?: S;
}

interface DefBase<P extends ParamSpecs, S> {
  /** Reverse-DNS-ish unique id, e.g. 'user.sub-bass'. Never change it once projects use it. */
  id: string;
  name: string;
  /** State/param schema version; bump it when you change params or state in a breaking way. */
  version: number;
  category?: string;
  description?: string;
  params: P;
  defaultState?: S;
  /** Named sample slots this plugin uses (lets the UI offer drop targets). */
  sampleSlots?: readonly string[];
  /**
   * false: the custom editor shows its own sample pickers (through `PluginUIProps.samples`), so the
   * editor window's header leaves them out. Default true.
   */
  samplePickers?: boolean;
  /** URL of the AudioWorklet module: `import processor from './x.worklet.ts?worker&url'`. */
  processor?: string;
  /** Upgrades data saved by an older `version`. */
  migrate?(old: { version: number; params: Record<string, unknown>; state: unknown }): {
    params: Record<string, unknown>;
    state: S;
  };
  /** Optional custom editor. Without it the host generates a knob panel from `params`. */
  ui?: PluginUIComponent<PluginUIProps<P, S>>;
  presets?: readonly Preset<P, S>[];
  /**
   * Live values the generated editor shows above the knobs (plugins without a custom `ui`): what the
   * kernel publishes with `Readings` (worklet defines need `tap: true`), e.g. gain reduction.
   */
  meters?: readonly PluginMeter[];
}

/** An instrument plugin: a synth or sampler that plays notes. Make one with `defineInstrument` (or `defineWorkletInstrument`). */
export interface InstrumentDef<P extends ParamSpecs = ParamSpecs, S = unknown> extends DefBase<P, S> {
  kind: 'instrument';
  create(host: PluginHost<P, S>): InstrumentInstance<S> | Promise<InstrumentInstance<S>>;
}

/** An effect plugin: audio goes in and comes out. Make one with `defineEffect` (or `defineWorkletEffect`). */
export interface EffectDef<P extends ParamSpecs = ParamSpecs, S = unknown> extends DefBase<P, S> {
  kind: 'effect';
  /** The effect listens to a sidechain (a compressor keyed by the kick): `host.sidechain` carries it. */
  sidechain?: boolean;
  /**
   * The effect follows the notes of an instrument channel: `param` names an int param (0 = none, 1 = the first
   * instrument channel in the rack, …) and `host.notes` delivers that channel's notes. With
   * `defineWorkletEffect` they reach the kernel's `noteOn`, `noteOff` and `allNotesOff`.
   */
  notes?: { param: string };
  create(host: PluginHost<P, S>): EffectInstance<S> | Promise<EffectInstance<S>>;
}

// Definitions are stored heterogeneously by the host.
/** An instrument definition of any params and state, as the host stores them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInstrumentDef = InstrumentDef<any, any>;
/** An effect definition of any params and state, as the host stores them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEffectDef = EffectDef<any, any>;
/** Any instrument or effect definition. */
export type PluginDef = AnyInstrumentDef | AnyEffectDef;

/** Declares an instrument plugin (adds `kind: 'instrument'`; the type parameters infer the param ids and value types). */
export function defineInstrument<const P extends ParamSpecs, S = undefined>(
  def: Omit<InstrumentDef<P, S>, 'kind'>,
): InstrumentDef<P, S> {
  return { kind: 'instrument', ...def };
}

/** Declares an effect plugin (adds `kind: 'effect'`; the type parameters infer the param ids and value types). */
export function defineEffect<const P extends ParamSpecs, S = undefined>(
  def: Omit<EffectDef<P, S>, 'kind'>,
): EffectDef<P, S> {
  return { kind: 'effect', ...def };
}
