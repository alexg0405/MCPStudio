import { memo } from 'react';
import { type ChannelId } from '@core/model/types';
import { stepView } from '@core/query/queries';
import { useDoc, useServices, useView } from '../../services-context';
import { MiniRoll } from './MiniRoll';
import { STEP_W, stepX } from './layout';
import styles from './ChannelRack.module.css';
import { beginPaint, endPaint, paintEnter } from './step-paint';

/** Which steps are on, as "0100…": all the step buttons show, so a row whose steps did not change skips rendering. */
const stepBits = (() => {
  const cache = new WeakMap<object, string>();
  return (view: ReturnType<typeof stepView>): string => {
    let bits = cache.get(view);
    if (bits === undefined) {
      bits = view.velocities.map((v) => (v > 0 ? '1' : '0')).join('');
      cache.set(view, bits);
    }
    return bits;
  };
})();

/**
 * The buttons of one row's steps. They carry no handlers (the grid handles pointer events for all of
 * them) and their only prop is which steps are on, so switching patterns re-renders just the rows whose
 * steps differ.
 */
const StepButtons = memo(function StepButtons({ on, channelName }: { on: string; channelName: string }) {
  return (
    <>
      {Array.from(on, (bit, i) => (
        <button
          key={i}
          className={`${styles.step} ${Math.floor(i / 4) % 2 ? styles.stepB : ''} ${bit === '1' ? styles.stepOn : ''}`}
          style={{ left: stepX(i) }}
          data-step={i}
          data-hint={`Step ${i + 1}. Click or drag to paint (tap a lit step to turn it off), right-click to erase`}
          aria-pressed={bit === '1'}
          aria-label={`${channelName} step ${i + 1}`}
        />
      ))}
    </>
  );
});

/** The step button under a pointer event, and whether it is on. */
function stepUnder(e: React.MouseEvent): { index: number; on: boolean } | null {
  const button = (e.target as Element).closest<HTMLElement>('[data-step]');
  return button ? { index: Number(button.dataset.step), on: button.getAttribute('aria-pressed') === 'true' } : null;
}

export function StepGrid({ channelId, channelName, rootKey }: { channelId: ChannelId; channelName: string; rootKey: number }) {
  const services = useServices();
  const patternId = useView((s) => s.currentPatternId);
  const stepCount = useDoc((pr) => (patternId ? pr.patterns[patternId]?.stepCount : undefined)) ?? 16;
  const notes = useDoc((pr) => (patternId ? pr.patterns[patternId]?.notes[channelId] : undefined));
  const view = stepView(notes, stepCount);
  if (!patternId) return null;

  if (!view.isSteps) {
    return (
      <div className={styles.steps} data-steps style={{ width: stepX(stepCount - 1) + STEP_W }}>
        <MiniRoll channelId={channelId} patternId={patternId} width={stepX(stepCount - 1) + STEP_W} />
      </div>
    );
  }

  return (
    <div
      className={styles.steps}
      data-steps
      data-touch-own=""
      style={{ width: stepX(stepCount - 1) + STEP_W }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        // Space or Enter on a focused step (detail 0): the mouse and fingers already acted on pointer down.
        if (e.detail !== 0) return;
        const step = stepUnder(e);
        if (!step) return;
        beginPaint(services, patternId, channelId, rootKey, step.index, !step.on);
        endPaint();
      }}
      onPointerDown={(e) => {
        const step = stepUnder(e);
        if (!step) return;
        e.preventDefault();
        if (e.button === 2) beginPaint(services, patternId, channelId, rootKey, step.index, false);
        else if (e.button === 0) beginPaint(services, patternId, channelId, rootKey, step.index, !step.on);
      }}
      onPointerOver={(e) => {
        const step = stepUnder(e);
        if (step) paintEnter(channelId, step.index, e.buttons);
      }}
      onPointerMove={(e) => {
        // A finger stays on the step it landed on (touch pointers are captured by it), so no pointerover reaches the
        // steps it passes: find the one under it, in this row.
        if (e.pointerType !== 'touch') return;
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-step]');
        if (under && under.closest('[data-steps]') === e.currentTarget) paintEnter(channelId, Number(under.dataset.step), e.buttons);
      }}
    >
      <StepButtons on={stepBits(view)} channelName={channelName} />
    </div>
  );
}
