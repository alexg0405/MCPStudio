import { createElement, use, type ComponentType } from 'react';
import type { PluginUIComponent } from '../types';

type Tracked = Promise<void> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: undefined; reason?: unknown };

/**
 * A plugin editor whose code loads when its window first opens instead of with the plugin, so a plugin with a big
 * custom UI costs nothing at startup:
 *
 *   ui: lazyUi(() => import('./MyUI').then((m) => m.MyUI)),
 *
 * The window shows "Loading…" for the moment the code takes (it is also fetched a few seconds after start, so it is
 * usually there already, and then the editor renders at once). Keep the UI's imports out of the plugin's `index.ts`,
 * or it loads with it anyway.
 */
export function lazyUi<Props>(load: () => Promise<PluginUIComponent<Props>>): PluginUIComponent<Props> {
  let ready: PluginUIComponent<Props> | null = null;
  let loading: Tracked | null = null;
  const start = (): Tracked => {
    if (loading) return loading;
    const p: Tracked = load().then(
      (c) => {
        ready = c;
      },
      (err: unknown) => {
        loading = null;
        throw err;
      },
    );
    // React's `use` returns at once for a promise marked fulfilled (it reads `status`), so a loaded editor never
    // suspends: a React.lazy component would suspend on its first render, and React holds the content back for up
    // to 300 ms after showing the fallback.
    p.status = 'pending';
    p.then(
      () => {
        p.status = 'fulfilled';
      },
      (reason: unknown) => {
        p.status = 'rejected';
        p.reason = reason;
      },
    );
    return (loading = p);
  };
  if (typeof window !== 'undefined')
    setTimeout(() => {
      const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback;
      const go = () => void start().catch(() => undefined);
      if (idle) idle.call(window, go, { timeout: 8000 });
      else go();
    }, 3000);
  const Lazy = (props: Props) => {
    use(start() as Promise<void>);
    return createElement(ready as unknown as ComponentType<object>, props as object);
  };
  return Lazy as unknown as PluginUIComponent<Props>;
}
