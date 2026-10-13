import { createContext } from 'react';
import type { ParamValue } from '../params';

/**
 * Provided by the host around plugin editors: opens a param's menu (create automation clip, link to
 * controller, reset, type in a value…). Controls given a `param` id use it on right-click.
 */
export const ParamMenuContext = createContext<
  ((param: string, at: { clientX: number; clientY: number }) => void) | null
>(null);

/**
 * Provided by the host: lets a control show the value automation gives its param while playing.
 * `follow(param, paint)` calls `paint(value)` (from the frame loop, outside React) while automation
 * drives the param and `paint(null)` when it lets go; it returns the unsubscribe function.
 */
export const ParamFollowContext = createContext<
  ((param: string, paint: (value: ParamValue | null) => void) => () => void) | null
>(null);
