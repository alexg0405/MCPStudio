import { useEffect, useRef } from 'react';
import { MASTER } from '@core/model/types';
import { R } from '@engine/meter/layout';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { lufsText, peakDbText, peakState } from '../meters/meters-model';
import styles from './Mixer.module.css';

/** The readout is rewritten at most this often (ms): digits that change faster cannot be read. */
const REFRESH_MS = 150;

/**
 * A small loudness readout on the master strip: short-term loudness (LUFS) and true peak (dBTP). Clicking it opens the
 * Meters window. It holds a basic meter while the mixer is open (loudness and peaks only: the cheapest one).
 */
export function MasterLoudness() {
  const services = useServices();
  const loudness = useRef<HTMLSpanElement>(null);
  const peak = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const lease = services.meters.listen(MASTER, { full: false });
    let last = 0;
    const stop = onFrame((now) => {
      if (now - last < REFRESH_MS) return;
      last = now;
      const readings = lease.meter.readings;
      const truePeak = Math.max(readings[R.truePeakL] as number, readings[R.truePeakR] as number);
      if (loudness.current) loudness.current.textContent = lufsText(readings[R.shortTerm] as number);
      if (peak.current) {
        peak.current.textContent = peakDbText(truePeak);
        peak.current.dataset.state = peakState(truePeak);
      }
    });
    return () => {
      stop();
      lease.release();
    };
  }, [services]);

  return (
    <button
      type="button"
      tabIndex={-1}
      className={styles.masterLoudness}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => openWindow(services, 'meters')}
      data-hint="Master loudness over the last 3 seconds (LUFS-S) and true peak (dBTP, held since play). Click to open the Meters window"
      aria-label="Open the Meters window"
    >
      <span ref={loudness}>−∞</span>
      <small>LUFS-S</small>
      <span ref={peak} data-state="none">
        −∞
      </span>
      <small>TP dBTP</small>
    </button>
  );
}
