/** Painting steps along one row of a channel (FL style): press on a step, drag, and every step passed changes together. */
import { type ChannelId, type PatternId } from '@core/model/types';
import { setStep } from '@core/ops/notes';
import type { Services } from '@app/services';


/** A paint in progress along one row of steps: which steps it has touched and whether it turns them on or off. */
interface Paint {
  channelId: ChannelId;
  on: boolean;
  done: Set<number>;
  /** Last step painted; fast drags fill every step in between. */
  last: number;
  commit(): void;
  apply(step: number): void;
}

/** The paint in progress (one at a time, shared by every step grid). */
let paint: Paint | null = null;

/** Starts painting steps on (or off) from `step`; the whole drag is one undo step, committed by `endPaint`. */
export function beginPaint(
  services: Services,
  patternId: PatternId,
  channelId: ChannelId,
  rootKey: number,
  step: number,
  on: boolean,
) {
  const gesture = services.history.gesture(on ? 'Paint steps' : 'Erase steps');
  const done = new Set<number>();
  paint = {
    channelId,
    on,
    done,
    last: step,
    apply(target) {
      const from = Math.min(this.last, target);
      const to = Math.max(this.last, target);
      this.last = target;
      const todo: number[] = [];
      for (let s = from; s <= to; s++) if (!done.has(s)) todo.push(s);
      if (todo.length === 0) return;
      for (const s of todo) done.add(s);
      gesture.update((d) => {
        for (const s of todo) setStep(d, patternId, channelId, s, on, { rootKey });
      });
    },
    commit: () => gesture.commit(),
  };
  paint.apply(step);
  // Audition the step when turning it on.
  if (on) {
    const id = services.engine.previewNoteOn(channelId, rootKey, 100 / 128);
    setTimeout(() => services.engine.previewNoteOff(channelId, id), 120);
  }
}

/** Ends the paint in progress and commits it as one undo step. */
export function endPaint() {
  paint?.commit();
  paint = null;
}

/** The pointer moved over a step while painting: paints it (and the steps skipped on the way) in the same row. */
export function paintEnter(channelId: ChannelId, step: number, buttons: number) {
  // The button was let go where no pointerup reached us (outside the window): that ends the paint.
  if (paint && buttons === 0) endPaint();
  if (paint && paint.channelId === channelId) paint.apply(step);
}
