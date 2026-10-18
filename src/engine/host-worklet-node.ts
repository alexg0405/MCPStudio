import type { PluginOwner } from '@core/model/types';
import {
  encode,
  isAutomatable,
  messageParamNames,
  type ParamSpec,
  type ParamSpecs,
  type PluginDef,
  type WorkletOptions,
} from '@agstudio/sdk';
import { liteName, type ProcessorInit } from '@agstudio/sdk/protocol';
import type { ParamHandleImpl } from './param-handle';

/** The worklet node of a plugin instance, and how its params reach the audio thread. */
export interface PluginNode {
  node: AudioWorkletNode;
  /** The params that travel as events to the processor, in the order the processor numbers them. */
  messageNames: string[];
  /** The node is the kernel's lite processor (every param is an event, no AudioParams). */
  isLite: boolean;
}

/** What `createPluginNode` needs to know about the instance. */
export interface PluginNodeSpec {
  ctx: BaseAudioContext;
  def: PluginDef;
  owner: PluginOwner;
  params: Record<string, ParamHandleImpl<ParamSpec>>;
  /** The plugin's state as the processor starts with it. */
  state: unknown;
  options: WorkletOptions;
  /** Nothing automates this instance, so the lite processor may be used (see HostDeps.lite). */
  mayBeLite: boolean;
}

/** Stable per-instance seed so kernels' random numbers repeat across renders (FNV-1a over plugin and owner ids). */
function seedFor(owner: PluginOwner, pluginId: string): number {
  const key = `${pluginId}:${owner.kind === 'channel' ? owner.channelId : owner.slotId}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/**
 * Creates the plugin's AudioWorkletNode: the kernel's lite processor when nothing automates the instance (and the
 * caller did not ask for a particular processor), else the full one with an AudioParam per automatable param.
 */
export function createPluginNode(spec: PluginNodeSpec): PluginNode {
  const { def, options } = spec;
  const nodeOptions = {
    numberOfInputs: options.numberOfInputs ?? (def.kind === 'effect' ? 1 : 0),
    numberOfOutputs: 1,
    outputChannelCount: options.outputChannelCount ?? [2],
    channelCount: 2,
    channelCountMode: 'explicit' as const,
  };
  const seed = seedFor(spec.owner, def.id);
  // A kernel registered by registerKernel has a lite processor; one registered otherwise, or under another name,
  // doesn't and runs as it is.
  if (!options.name && spec.mayBeLite) {
    const lite = tryCreateLiteNode(spec, nodeOptions, seed);
    if (lite) return lite;
  }
  return createFullNode(spec, nodeOptions, seed);
}

type NodeOptions = Pick<AudioWorkletNodeOptions, 'numberOfInputs' | 'numberOfOutputs' | 'outputChannelCount' | 'channelCount' | 'channelCountMode'>;

/** The lite processor, where every param is an event; null where the browser has none under that name. */
function tryCreateLiteNode(spec: PluginNodeSpec, nodeOptions: NodeOptions, seed: number): PluginNode | null {
  const { ctx, def, params } = spec;
  const initialValues: Record<string, number> = {};
  for (const [key, handle] of Object.entries(params)) initialValues[key] = encode(handle.spec, handle.value);
  try {
    const node = new AudioWorkletNode(ctx, liteName(def.id), {
      ...nodeOptions,
      processorOptions: { kind: def.kind, state: spec.state, seed, params: initialValues } satisfies ProcessorInit,
    });
    return { node, messageNames: Object.keys(params), isLite: true };
  } catch {
    return null;
  }
}

/** The full processor: params automation can drive are AudioParams; the rest (enums, switches…) travel as events. */
function createFullNode(spec: PluginNodeSpec, nodeOptions: NodeOptions, seed: number): PluginNode {
  const { ctx, def, params } = spec;
  const parameterData: Record<string, number> = {};
  const messageData: Record<string, number> = {};
  for (const [key, handle] of Object.entries(params)) {
    const target = isAutomatable(handle.spec) ? parameterData : messageData;
    target[key] = encode(handle.spec, handle.value);
  }
  const node = new AudioWorkletNode(ctx, spec.options.name ?? def.id, {
    ...nodeOptions,
    parameterData,
    processorOptions: { kind: def.kind, state: spec.state, seed, params: messageData } satisfies ProcessorInit,
  });
  for (const [key, handle] of Object.entries(params)) {
    const audioParam = node.parameters.get(key);
    if (audioParam) handle.bind(audioParam);
  }
  return { node, messageNames: messageParamNames(def.params as ParamSpecs), isLite: false };
}
