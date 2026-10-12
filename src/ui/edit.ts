import { useRef } from 'react';
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
  return {
    onBegin() {
      gesture.current = services.history.gesture(label);
    },
    onChange(v: V) {
      if (gesture.current?.active) gesture.current.update((d) => recipe(d, v));
      else services.history.transact(label, (d) => recipe(d, v), mergeKey ? { mergeKey } : {});
    },
    onEnd() {
      gesture.current?.commit();
      gesture.current = null;
    },
    onCommit(v: V) {
      services.history.transact(label, (d) => recipe(d, v), mergeKey ? { mergeKey } : {});
    },
  };
}
