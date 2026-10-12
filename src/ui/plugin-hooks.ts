import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Gesture } from '@core/history/history';
import type { PluginOwner } from '@core/model/types';
import { setPluginParam, setPluginParams, setPluginState } from '@core/ops/channels';
import type { JsonValue, ParamValue, PluginDef } from '@agstudio/sdk';
import { useServices } from './services-context';

/** The current definition for a plugin id (re-renders when plugins are added, removed or hot-reloaded). */
export function usePluginDef(pluginId: string | undefined): PluginDef | undefined {
  const { plugins } = useServices();
  const subscribe = useCallback((fn: () => void) => plugins.subscribe(fn), [plugins]);
  useSyncExternalStore(subscribe, () => plugins.getVersion());
  return pluginId ? plugins.get(pluginId) : undefined;
}

/** Edit callbacks for a plugin's params/state, mapped onto undo history (one step per knob drag). */
export function usePluginEditing(owner: PluginOwner, def: PluginDef | undefined) {
  const services = useServices();
  const gestures = useRef(new Map<string, Gesture>());
  const label = (param: string) => `${def?.name ?? 'Plugin'}: ${def?.params[param]?.label ?? param}`;
  return {
    beginEdit(param: string) {
      gestures.current.get(param)?.commit();
      gestures.current.set(param, services.history.gesture(label(param)));
    },
    setParam(param: string, value: ParamValue) {
      const g = gestures.current.get(param);
      const recipe = (d: Parameters<typeof setPluginParam>[0]) => setPluginParam(d, owner, param, value);
      if (g?.active) g.update(recipe);
      else services.history.transact(label(param), recipe, { mergeKey: `param:${param}` });
    },
    endEdit(param: string) {
      gestures.current.get(param)?.commit();
      gestures.current.delete(param);
    },
    setParams(values: Record<string, ParamValue>, what: string) {
      services.history.transact(what, (d) => setPluginParams(d, owner, values));
    },
    setState(next: unknown) {
      services.history.transact(`${def?.name ?? 'Plugin'}: state`, (d) => setPluginState(d, owner, next as JsonValue));
    },
  };
}
