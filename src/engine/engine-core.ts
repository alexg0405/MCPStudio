import type { InsertId, PluginOwner } from '@core/model/types';
import type { JsonValue, TransportInfo } from '@agstudio/sdk';
import type { PluginResolver } from './api';
import type { ParamRegistry } from './param-lane';
import type { SampleCache } from './samples';
import type { WorkletPortImpl } from './worklet-port';

/** What channel strips and mixer inserts need from the engine (keeps them decoupled from it). */
export interface EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  readonly transportInfo: TransportInfo;
  readonly offline: boolean;
  /** Automatable params by target key (automation, controller links, knobs that follow automation). */
  readonly params: ParamRegistry;
  insertInput(id: InsertId): AudioNode;
  requestState(owner: PluginOwner, state: JsonValue): void;
  reportFault(owner: PluginOwner, pluginId: string, err: unknown): void;
  loadModule(url: string): Promise<void>;
  readonly ports: Set<WorkletPortImpl>;
  /** Something subscribers show changed (e.g. a time-stretch started or finished). */
  notify?(): void;
}
