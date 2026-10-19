import { useEffect, useRef } from 'react';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import styles from './Recording.module.css';

/** The meter is empty at this level and full at 0 dB (dB). */
const METER_FLOOR_DB = -60;
/** How much of the bar a bar falls back per frame (0 to 1): meters fall slowly so a peak can be seen. */
const METER_FALL_PER_FRAME = 0.02;
/** A peak at or above this (linear) lights the clip warning. */
const CLIP_LEVEL = 0.99;

/** Two bars that follow the input's level on the frame loop (no React renders). */
export function LevelMeter() {
  const services = useServices();
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const levels = new Float32Array(2);
    const shownWidth = [0, 0];
    return onFrame(() => {
      services.audioInput.levels(levels);
      [left, right].forEach((ref, channel) => {
        const peak = levels[channel] as number;
        const db = peak > 0 ? 20 * Math.log10(peak) : -120;
        const target = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
        shownWidth[channel] = Math.max(target, (shownWidth[channel] as number) - METER_FALL_PER_FRAME);
        const bar = ref.current;
        if (bar) {
          bar.style.width = `${(shownWidth[channel] as number) * 100}%`;
          bar.dataset.clip = peak >= CLIP_LEVEL ? 'true' : 'false';
        }
      });
    });
  }, [services]);
  return (
    <div className={styles.meter} data-hint="Input level (−60 to 0 dB): play or speak; keep it out of the red at the right">
      <div className={styles.meterRow}>
        <div ref={left} className={styles.meterBar} />
      </div>
      <div className={styles.meterRow}>
        <div ref={right} className={styles.meterBar} />
      </div>
    </div>
  );
}
