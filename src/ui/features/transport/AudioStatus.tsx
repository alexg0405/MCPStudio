import { useLayoutEffect, useRef } from 'react';
import { useEngineStatus, useServices } from '../../services-context';
import { onFrame } from '../../frame-loop';
import styles from './Transport.module.css';

/**
 * Audio state, sample rate, latency and late-note count; click to enable audio.
 * Registered twice: the "Audio off" button sits with the window buttons so it is always visible, while the
 * stats live in the center area and are the first thing to move into the toolbar's overflow menu.
 */
export function AudioStatus({ show }: { show: 'enable' | 'stats' }) {
  const services = useServices();
  const { state } = useEngineStatus();
  const ref = useRef<HTMLSpanElement>(null);

  // Filled in before the first paint and then about twice a second. A chip that appeared empty and
  // grew a moment later changed its width, which made the toolbar move it into "More" and back.
  useLayoutEffect(() => {
    let last = '';
    let frame = 0;
    const update = () => {
      if (!ref.current) return;
      const st = services.engine.stats();
      const latency = Math.round((st.baseLatency + st.outputLatency) * 1000);
      const text = `${(st.sampleRate / 1000).toFixed(1)} kHz · ${latency} ms${st.lateEvents ? ` · ${st.lateEvents} late` : ''}`;
      if (text !== last) {
        ref.current.textContent = text;
        last = text;
      }
    };
    update();
    return onFrame(() => {
      if (++frame % 30 === 0) update();
    });
  }, [services, state]);

  if (state !== 'running') {
    if (show === 'stats') return null;
    return (
      <button
        className={styles.audioOff}
        tabIndex={-1}
        onClick={() => void services.engine.resume()}
        data-hint="The browser keeps audio off until you interact with the page"
      >
        Audio off · click to enable
      </button>
    );
  }
  if (show === 'enable') return null;
  return (
    <span className={styles.audioStatus} data-hint="Sample rate, output latency and late notes (scheduling hiccups)">
      <span ref={ref} />
    </span>
  );
}
