import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Gesture } from '@core/history/history';
import type { InsertId } from '@core/model/types';
import { planLinkedEdit, type LinkedControl, type LinkedEdit } from '@core/ops/linked-edits';
import { useServices } from '../../services-context';

/**
 * Connects a strip's fader or pan control to the undo history like `useGestureEdit`, and moves the track's group mates
 * with it when its group links that control. A drag is one gesture (one undo step); the mates are computed from where the
 * drag started, so dragging back puts everyone back exactly. Wheel and double-click edits plan from the current mix.
 */
export function useLinkedInsertEdit(label: string, insertId: InsertId, control: LinkedControl, mergeKey: string) {
  const services = useServices();
  const gesture = useRef<Gesture | null>(null);
  const dragPlan = useRef<LinkedEdit | null>(null);
  // The handlers are made once and read the latest props, so a memoized control is not re-rendered by its parent.
  const latest = useRef({ label, insertId, control, mergeKey });
  useLayoutEffect(() => {
    latest.current = { label, insertId, control, mergeKey };
  });
  return useMemo(() => {
    const planNow = () => {
      const { insertId, control } = latest.current;
      return planLinkedEdit(services.doc.getState().project, insertId, control);
    };
    const commitOnce = (value: number) => {
      const { label, mergeKey } = latest.current;
      const plan = planNow();
      services.history.transact(label, (draft) => plan(draft, value), { mergeKey });
    };
    return {
      onBegin() {
        dragPlan.current = planNow();
        gesture.current = services.history.gesture(latest.current.label);
      },
      onChange(value: number) {
        const plan = dragPlan.current;
        if (gesture.current?.active && plan) gesture.current.update((draft) => plan(draft, value));
        else commitOnce(value);
      },
      onEnd() {
        gesture.current?.commit();
        gesture.current = null;
        dragPlan.current = null;
      },
      onCommit: commitOnce,
    };
  }, [services]);
}
