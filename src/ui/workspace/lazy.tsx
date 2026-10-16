import { lazy, type ComponentType } from 'react';
import type { WindowContentProps } from './registry';

function idle(fn: () => void, timeout = 4000): void {
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric.call(window, fn, { timeout });
  else setTimeout(fn, 1500);
}

let started = false;
const queue: (() => void)[] = [];

/**
 * Runs `fn` once the app is up and the browser has nothing better to do (used to fetch code that is needed
 * later, so it never competes with startup). Nothing runs before `startPrefetching()`, nor in Node tests.
 */
export function whenIdle(fn: () => void): void {
  if (typeof window === 'undefined') return;
  if (started) idle(fn);
  else queue.push(fn);
}

/** Called once, after the first paint: lets everything queued by `whenIdle` run, one piece per idle moment. */
export function startPrefetching(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  for (const fn of queue.splice(0)) idle(fn);
}

/**
 * A window whose code loads on first use instead of at startup (the shell shows "Loading…" for a
 * moment). The chunk is also fetched when the browser is idle after startup, so by the time you open the
 * window it is usually there already.
 */
export function lazyWindow<M, P extends WindowContentProps = WindowContentProps>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): ComponentType<P> {
  const component = lazy(() => load().then((m) => ({ default: pick(m) })));
  whenIdle(() => void load());
  return component as unknown as ComponentType<P>;
}
