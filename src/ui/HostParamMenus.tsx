import type { ReactNode } from 'react';
import { parseTargetKey } from '@core/model/targets';
import { ParamMenuContext } from '@agstudio/sdk/ui';
import { useServices } from './services-context';
import { paramInfoFor, showParamMenu } from './param-menu';

/**
 * Param menus for the host's own knobs: a Knob/Toggle/Select whose `param` is a target key
 * (`targetKey({ kind: 'channel', channelId, param: 'volume' })`) gets the menu on right-click.
 * Plugin windows provide their own (param ids of the plugin).
 */
export function HostParamMenus({ children }: { children: ReactNode }) {
  const services = useServices();
  const open = (key: string, at: { clientX: number; clientY: number }) => {
    const target = parseTargetKey(key);
    const info = target ? paramInfoFor(services, target) : null;
    if (info) showParamMenu(at, info, services);
  };
  return <ParamMenuContext.Provider value={open}>{children}</ParamMenuContext.Provider>;
}
