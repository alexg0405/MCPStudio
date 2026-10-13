import { createContext } from 'react';

/**
 * Provided by the host around plugin editors: opens a param's menu (create automation clip, link to
 * controller, reset, type in a value…). Controls given a `param` id use it on right-click.
 */
export const ParamMenuContext = createContext<
  ((param: string, at: { clientX: number; clientY: number }) => void) | null
>(null);
