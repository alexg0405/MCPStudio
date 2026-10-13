import { useEffect, useRef } from 'react';
import type { ChannelId, PatternId } from '@core/model/types';
import { notesSorted, patternLength } from '@core/query/queries';
import { useDoc, useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { fitCanvas, readTheme } from '../../timeline/canvas';
import styles from './ChannelRack.module.css';

/** FL-style preview of a channel's piano-roll notes in the channel rack. Click to open the piano roll. */
export function MiniRoll({
  channelId,
  patternId,
  width,
}: {
  channelId: ChannelId;
  patternId: PatternId;
  width: number;
}) {
  const services = useServices();
  const ref = useRef<HTMLCanvasElement>(null);
  const notes = useDoc((p) => p.patterns[patternId]?.notes[channelId]);
  const pattern = useDoc((p) => p.patterns[patternId]);
  const ts = useDoc((p) => p.transport.timeSig);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !pattern) return;
    const h = 22;
    const ctx = fitCanvas(canvas, width, h);
    const theme = readTheme();
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, h);
    const sorted = notesSorted(notes);
    const len = patternLength(pattern, ts);
    let lo = 127;
    let hi = 0;
    for (const n of sorted) {
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
    }
    const range = Math.max(6, hi - lo + 1);
    const pad = (range - (hi - lo + 1)) / 2;
    const sx = width / len;
    ctx.fillStyle = theme.note;
    for (const n of sorted) {
      const y = h - 2 - ((n.key - lo + pad + 1) / range) * (h - 4);
      ctx.fillRect(n.tick * sx, y, Math.max(1.5, n.length * sx - 0.5), Math.max(1.5, (h - 4) / range));
    }
  }, [notes, pattern, ts, width]);

  return (
    <canvas
      ref={ref}
      className={styles.miniRoll}
      style={{ width, height: 22 }}
      onPointerDown={(e) => {
        e.preventDefault();
        services.session.getState().selectChannel(channelId);
        openWindow(services, 'piano-roll');
      }}
      data-hint="Piano roll notes. Click to edit them in the piano roll (F7)"
    />
  );
}
