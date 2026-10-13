import type { ReactNode } from 'react';
import type { Services } from '@app/services';
import { parseTargetKey } from '@core/model/targets';
import { ParamFollowContext, ParamMenuContext } from '@agstudio/sdk/ui';
import { AutomationFollowers } from './follow-automation';
import { useServices } from './services-context';
import { paramInfoFor, showParamMenu } from './param-menu';

const followers = new WeakMap<Services, AutomationFollowers>();

/** The services' automation followers (one per app; created on first use, never in an effect). */
export function followersOf(s: Services): AutomationFollowers {
  let f = followers.get(s);
  if (!f) followers.set(s, (f = new AutomationFollowers(() => s.engine)));
  return f;
}

/**
 * Param menus and automation display for the host's own knobs: a Knob/Toggle/Select whose `param`
 * is a target key (`targetKey({ kind: 'channel', channelId, param: 'volume' })`) gets the menu on
 * right-click and shows automated values while playing. Plugin windows provide their own (param ids).
 */
export function HostParamMenus({ children }: { children: ReactNode }) {
  const services = useServices();
  const open = (key: string, at: { clientX: number; clientY: number }) => {
    const target = parseTargetKey(key);
    const info = target ? paramInfoFor(services, target) : null;
    if (info) showParamMenu(at, info, services);
  };
  const follow = (key: string, paint: Parameters<AutomationFollowers['follow']>[2]) => {
    const target = parseTargetKey(key);
    const info = target ? paramInfoFor(services, target) : null;
    return info ? followersOf(services).follow(key, info.spec, paint) : () => {};
  };
  return (
    <ParamMenuContext.Provider value={open}>
      <ParamFollowContext.Provider value={follow}>{children}</ParamFollowContext.Provider>
    </ParamMenuContext.Provider>
  );
}
