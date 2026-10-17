import { createElement, use, type ComponentType } from 'react';
import type { WindowContentProps } from './registry';

function idle(fn: () => void, timeout = 4000): void {
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
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

/** A promise React's `use` returns from at once when it is marked fulfilled (it reads `status`, as for its own). */
type Tracked = Promise<void> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: undefined; reason?: unknown };

function tracked(p: Promise<void>): Tracked {
  const t = p as Tracked;
  t.status = 'pending';
  t.then(
    () => {
      t.status = 'fulfilled';
    },
    (reason: unknown) => {
      t.status = 'rejected';
      t.reason = reason;
    },
  );
  return t;
}

/**
 * A window whose code loads on first use instead of at startup (the shell shows "Loading…" for a
 * moment). The chunk is also fetched when the browser is idle after startup, so by the time you open the
 * window it is usually there already, and then the window renders at once. (A `React.lazy` component suspends the
 * first time it renders even with its chunk in memory, and React holds the real content back for up to 300 ms
 * after showing the fallback: the first open of every lazy window took ~300 ms. Here `use()` gets a promise marked
 * fulfilled once the chunk is in, which does not suspend.)
 */
export function lazyWindow<M, P extends WindowContentProps = WindowContentProps>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): ComponentType<P> {
  let ready: ComponentType<P> | null = null;
  let loading: Tracked | null = null;
  const start = (): Tracked =>
    (loading ??= tracked(
      load().then(
        (m) => {
          ready = pick(m);
        },
        (err: unknown) => {
          loading = null; // a network hiccup: the next open tries again
          throw err;
        },
      ),
    ));
  whenIdle(() => void start().catch(() => undefined));
  return function LazyWindow(props: P) {
    use(start() as Promise<void>);
    return createElement(ready as unknown as ComponentType<P>, props);
  };
}
