import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Draft } from 'immer';
import type { Gesture } from '@core/history/history';
import type { Project } from '@core/model/types';
import { useServices } from './services-context';

/**
 * Connects a continuous control (knob, fader, drag number) to the undo history: a drag is one
 * gesture (one undo step, live updates while dragging); wheel/double-click edits merge by key.
 */
export function useGestureEdit<V>(label: string, recipe: (d: Draft<Project>, v: V) => void, mergeKey?: string) {
  const services = useServices();
  const gesture = useRef<Gesture | null>(null);
  // The handlers are made once and read the latest label and recipe, so a control that gets them (a memoized
  // Knob) is not re-rendered just because its parent was: during a drag the parent renders on every move.
  const latest = useRef({ label, recipe, mergeKey });
  useLayoutEffect(() => {
    latest.current = { label, recipe, mergeKey };
  });
  return useMemo(
    () => ({
      onBegin() {
        gesture.current = services.history.gesture(latest.current.label);
      },
      onChange(v: V) {
        const { label, recipe, mergeKey } = latest.current;
        if (gesture.current?.active) gesture.current.update((d) => recipe(d, v));
        else services.history.transact(label, (d) => recipe(d, v), mergeKey ? { mergeKey } : {});
      },
      onEnd() {
        gesture.current?.commit();
        gesture.current = null;
      },
      onCommit(v: V) {
        const { label, recipe, mergeKey } = latest.current;
        services.history.transact(label, (d) => recipe(d, v), mergeKey ? { mergeKey } : {});
      },
    }),
    [services],
  );
}
