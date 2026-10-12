import { useEffect, useRef } from 'react';
import { useEngineStatus, useServices } from '../../services-context';
import { onFrame } from '../../frame-loop';
import styles from './Transport.module.css';

/** Audio state, sample rate, latency and late-note count; click to enable audio. */
export function AudioStatus() {
  const services = useServices();
  const { state } = useEngineStatus();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let last = '';
    let frame = 0;
    return onFrame(() => {
      if (frame++ % 30 !== 0 || !ref.current) return;
      const st = services.engine.stats();
      const latency = Math.round((st.baseLatency + st.outputLatency) * 1000);
      const text = `${(st.sampleRate / 1000).toFixed(1)} kHz · ${latency} ms${st.lateEvents ? ` · ${st.lateEvents} late` : ''}`;
      if (text !== last) {
        ref.current.textContent = text;
        last = text;
      }
    });
  }, [services]);

  if (state !== 'running') {
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
  return (
    <span className={styles.audioStatus} data-hint="Sample rate, output latency and late notes (scheduling hiccups)">
      <span ref={ref} />
    </span>
  );
}
