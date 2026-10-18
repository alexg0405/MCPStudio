import { createElement, use, type ComponentType } from 'react';
import type { PluginUIComponent } from '../types';

type Tracked = Promise<void> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: undefined; reason?: unknown };

/** The editor's code is fetched this long after start (so it is usually there before the window opens)… */
const PREFETCH_DELAY_MS = 3000;
/** …and when the browser is idle, but no later than this after the delay. */
const PREFETCH_IDLE_TIMEOUT_MS = 8000;

/**
 * Marks a load promise with the `status` React's `use` reads: a fulfilled promise returns at once, so a
 * loaded editor never suspends. (A React.lazy component would suspend on its first render, and React holds
 * the content back for up to 300 ms after showing the fallback.)
 */
function trackStatus(promise: Tracked): void {
  promise.status = 'pending';
  promise.then(
    () => {
      promise.status = 'fulfilled';
    },
    (reason: unknown) => {
      promise.status = 'rejected';
      promise.reason = reason;
    },
  );
}

/** Starts `load` a few seconds after start, when the browser has nothing better to do. */
function prefetchWhenIdle(load: () => Promise<void>): void {
  if (typeof window === 'undefined') return;
  setTimeout(() => {
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const go = () => void load().catch(() => undefined);
    if (idle) idle.call(window, go, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
    else go();
  }, PREFETCH_DELAY_MS);
}

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
    const promise: Tracked = load().then(
      (component) => {
        ready = component;
      },
      (err: unknown) => {
        // A failed load can be tried again the next time the window opens.
        loading = null;
        throw err;
      },
    );
    trackStatus(promise);
    return (loading = promise);
  };
  prefetchWhenIdle(start);
  const Lazy = (props: Props) => {
    use(start() as Promise<void>);
    return createElement(ready as unknown as ComponentType<object>, props as object);
  };
  return Lazy as unknown as PluginUIComponent<Props>;
}
