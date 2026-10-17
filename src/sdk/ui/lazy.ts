import { lazy } from 'react';
import type { PluginUIComponent } from '../types';

/**
 * A plugin editor whose code loads when its window first opens instead of with the plugin, so a plugin with a big
 * custom UI costs nothing at startup:
 *
 *   ui: lazyUi(() => import('./MyUI').then((m) => m.MyUI)),
 *
 * The window shows "Loading…" for the moment the code takes (it is also fetched a few seconds after start, so it is
 * usually there already). Keep the UI's imports out of the plugin's `index.ts`, or it loads with it anyway.
 */
export function lazyUi<Props>(load: () => Promise<PluginUIComponent<Props>>): PluginUIComponent<Props> {
  const component = lazy(() => load().then((c) => ({ default: c as unknown as React.ComponentType<Props> })));
  if (typeof window !== 'undefined')
    setTimeout(() => {
      const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      const go = () => void load().catch(() => undefined);
      if (idle) idle.call(window, go, { timeout: 8000 });
      else go();
    }, 3000);
  return component as unknown as PluginUIComponent<Props>;
}
