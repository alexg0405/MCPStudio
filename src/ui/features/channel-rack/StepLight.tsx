import { useEffect, useRef } from 'react';
import { patternTickAt } from '@core/query/playlist';
import { useServices } from '../../services-context';
import { onFrame } from '../../frame-loop';
import { STEP_W, stepX } from './layout';
import styles from './ChannelRack.module.css';

/** Lights the step being played (moved on the frame loop, never through React). */
export function StepLight({ stepCount }: { stepCount: number }) {
  const services = useServices();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let last = -1;
    // Where the step column starts: read once (and again after a resize), since offsetLeft forces a layout.
    let columnLeft = -1;
    const ro = new ResizeObserver(() => (columnLeft = -1));
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    const stop = onFrame(() => {
      const el = ref.current;
      if (!el) return;
      const v = services.view.getState();
      let step = -1;
      if (services.engine.playing && v.currentPatternId) {
        const tick =
          v.mode === 'pattern'
            ? services.engine.playhead()
            : patternTickAt(services.doc.getState().project, services.engine.playhead(), v.currentPatternId);
        if (tick !== null) step = Math.floor(tick / 240);
      }
      const visible = step >= 0 && step < stepCount ? step : -1;
      if (visible === last) return;
      last = visible;
      el.style.opacity = visible < 0 ? '0' : '1';
      // The step column's offset is measured from the first row so CSS stays the source of truth.
      if (visible >= 0) {
        if (columnLeft < 0) columnLeft = el.parentElement?.querySelector<HTMLElement>('[data-steps]')?.offsetLeft ?? -1;
        el.style.transform = `translateX(${Math.max(0, columnLeft) + stepX(visible)}px)`;
      }
    });
    return () => {
      stop();
      ro.disconnect();
    };
  }, [services, stepCount]);
  return <div ref={ref} className={styles.stepLight} style={{ width: STEP_W, opacity: 0 }} aria-hidden />;
}
