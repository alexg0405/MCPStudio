import { useCallback, type ReactNode } from 'react';
import type { Services } from '@app/services';
import { parseTargetKey } from '@core/model/targets';
import { ParamFollowContext, ParamMenuContext, ParamStatusContext, type ParamStatus } from '@agstudio/sdk/ui';
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
 * right-click, shows automated values while playing and marks itself when a clip automates it.
 * Plugin windows provide their own (param ids).
 */
export function HostParamMenus({ children }: { children: ReactNode }) {
  const services = useServices();
  const open = useCallback(
    (key: string, at: { clientX: number; clientY: number }) => {
      const target = parseTargetKey(key);
      const info = target ? paramInfoFor(services, target) : null;
      if (info) showParamMenu(at, info, services);
    },
    [services],
  );
  const follow = useCallback(
    (key: string, paint: Parameters<AutomationFollowers['follow']>[2]) => {
      const target = parseTargetKey(key);
      const info = target ? paramInfoFor(services, target) : null;
      return info ? followersOf(services).follow(key, info.spec, paint) : () => {};
    },
    [services],
  );
  const status = useCallback(
    (key: string, cb: (s: ParamStatus | null) => void) => services.automation.watch(key, cb),
    [services],
  );
  return (
    <ParamMenuContext.Provider value={open}>
      <ParamFollowContext.Provider value={follow}>
        <ParamStatusContext.Provider value={status}>{children}</ParamStatusContext.Provider>
      </ParamFollowContext.Provider>
    </ParamMenuContext.Provider>
  );
}
