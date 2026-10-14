import { createContext, useContext, useEffect, useState } from 'react';
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

/** What the host says drives a param: an automation clip, a muted one, or recording in progress. */
export interface ParamStatus {
  kind: 'automated' | 'muted' | 'recording';
  /** Added to the control's hint, e.g. "Automated by clip ‘Cutoff · Lead’ – right-click to edit". */
  hint: string;
}

/**
 * Provided by the host: `watch(param, cb)` calls `cb` with the param's status now and whenever it
 * changes (null when nothing drives it); returns the unsubscribe function. Controls show a small
 * indicator and add the status to their hint.
 */
export const ParamStatusContext = createContext<
  ((param: string, cb: (status: ParamStatus | null) => void) => () => void) | null
>(null);

/** The host's status for a param (null without a host, a param, or anything driving it). */
export function useParamStatus(param: string | undefined): ParamStatus | null {
  const watch = useContext(ParamStatusContext);
  const [status, setStatus] = useState<ParamStatus | null>(null);
  useEffect(() => {
    if (!param || !watch) return;
    return watch(param, (next) =>
      setStatus((prev) => (prev && next && prev.kind === next.kind && prev.hint === next.hint ? prev : next)),
    );
  }, [param, watch]);
  return param && watch ? status : null;
}
