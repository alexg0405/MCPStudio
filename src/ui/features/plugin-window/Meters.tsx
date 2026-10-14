import { useEffect, useRef } from 'react';
import type { AudioTap, PluginMeter } from '@agstudio/sdk';
import { keyName } from '@core/time/ppq';
import { onFrame } from '../../frame-loop';
import styles from './PluginWindow.module.css';

const minus = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(1)}` : v.toFixed(1));

/** A reading as text ('—' while there is nothing to show). */
export function formatMeter(m: PluginMeter, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  switch (m.kind) {
    case 'reduction':
      return v > 0.05 ? `−${v.toFixed(1)} dB` : '0 dB';
    case 'db':
      return `${minus(v)} dB`;
    case 'hz':
      return v > 0 ? `${v < 1000 ? v.toFixed(1) : Math.round(v)} Hz` : '—';
    case 'note':
      return v >= 0 ? keyName(Math.round(v)) : '—';
    case 'cents':
      return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))} ct`;
  }
}

/**
 * The live values a plugin publishes (gain reduction, a detected pitch…), above its knobs. Updated
 * on the frame loop, never through React.
 */
export function Meters({ meters, tap }: { meters: readonly PluginMeter[]; tap: AudioTap | undefined }) {
  const values = useRef<(HTMLSpanElement | null)[]>([]);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (!tap) return;
    const shown: string[] = [];
    return onFrame(() => {
      meters.forEach((m, i) => {
        const v = tap.active ? tap.reading(m.reading) : undefined;
        const text = formatMeter(m, v);
        if (shown[i] === text) return;
        shown[i] = text;
        const el = values.current[i];
        if (el) el.textContent = text;
        const bar = bars.current[i];
        if (bar) bar.style.width = `${Math.min(100, (Math.max(0, v ?? 0) / (m.max ?? 12)) * 100)}%`;
      });
    });
  }, [meters, tap]);
  return (
    <div className={styles.meters}>
      {meters.map((m, i) => (
        <div key={m.reading} className={styles.meter} data-hint={m.hint ? `${m.label}: ${m.hint}` : m.label}>
          <span className={styles.meterLabel}>{m.label}</span>
          {m.kind === 'reduction' && (
            <span className={styles.meterTrack}>
              <span ref={(el) => void (bars.current[i] = el)} className={styles.meterBar} />
            </span>
          )}
          <span ref={(el) => void (values.current[i] = el)} className={styles.meterValue}>
            —
          </span>
        </div>
      ))}
    </div>
  );
}
