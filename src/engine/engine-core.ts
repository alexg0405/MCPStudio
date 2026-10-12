import type { InsertId, PluginOwner } from '@core/model/types';
import type { JsonValue, TransportInfo } from '@agstudio/sdk';
import type { PluginResolver } from './api';
import type { SampleCache } from './samples';
import type { WorkletPortImpl } from './worklet-port';

/** What channel strips and mixer inserts need from the engine (keeps them decoupled from it). */
export interface EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  readonly transportInfo: TransportInfo;
  readonly offline: boolean;
  insertInput(id: InsertId): AudioNode;
  requestState(owner: PluginOwner, state: JsonValue): void;
  reportFault(owner: PluginOwner, pluginId: string, err: unknown): void;
  loadModule(url: string): Promise<void>;
  readonly ports: Set<WorkletPortImpl>;
}
