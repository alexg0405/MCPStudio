import { createContext, useContext, useEffect, useRef } from 'react';

/** Runs a callback every animation frame until the returned function is called. */
export type FrameScheduler = (cb: (now: number) => void) => () => void;

/**
 * Provided by the host around plugin editors: its own frame loop (one requestAnimationFrame for
 * the whole app). Without a host, `useFrame` falls back to requestAnimationFrame.
 */
export const FrameContext = createContext<FrameScheduler | null>(null);

const rafLoop: FrameScheduler = (cb) => {
  let handle = 0;
  const tick = (now: number) => {
    handle = requestAnimationFrame(tick);
    cb(now);
  };
  handle = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(handle);
};

/**
 * Calls `draw(now)` every animation frame while the component is mounted (and `active`): the place
 * to read `props.tap` and paint a canvas. It never re-renders the component; keep what you draw
 * from in refs.
 *
 * ```tsx
 * const canvas = useRef<HTMLCanvasElement>(null);
 * useFrame(() => {
 *   if (tap?.spectrum(bins)) drawSpectrum(canvas.current, bins);
 * });
 * ```
 */
export function useFrame(draw: (now: number) => void, active = true): void {
  const schedule = useContext(FrameContext) ?? rafLoop;
  const latest = useRef(draw);
  useEffect(() => {
    latest.current = draw;
  });
  useEffect(() => {
    if (!active) return;
    return schedule((now) => latest.current(now));
  }, [schedule, active]);
}
