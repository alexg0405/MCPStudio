import { useMemo } from 'react';
import type { PlannedNote } from '@core/audio/transcribe';
import styles from './ConvertDialog.module.css';

/** The most notes the small piano roll draws (a long clip would make thousands of rects for a thumbnail). */
const MAX_DRAWN = 600;
const WIDTH = 600;
const HEIGHT = 84;
const PAD = 4;

/**
 * A thumbnail of the notes a conversion would write: time across, pitch (or, for drums, the drum) up. A look at the result
 * before it is made, not an editor: the real piano roll opens on the new pattern afterwards.
 */
export function MiniRoll(props: { notes: readonly PlannedNote[]; lengthTicks: number; barTicks: number }) {
  const { notes, lengthTicks, barTicks } = props;
  const drawn = useMemo(() => {
    if (notes.length === 0) return [];
    const shown = notes.length > MAX_DRAWN ? notes.filter((_, i) => i % Math.ceil(notes.length / MAX_DRAWN) === 0) : notes;
    const keys = shown.map((n) => n.key);
    const low = Math.min(...keys);
    const high = Math.max(...keys);
    const rows = Math.max(6, high - low + 1);
    const rowHeight = (HEIGHT - 2 * PAD) / rows;
    return shown.map((n) => ({
      x: (n.tick / Math.max(1, lengthTicks)) * WIDTH,
      width: Math.max(2, (n.length / Math.max(1, lengthTicks)) * WIDTH - 1),
      y: PAD + (high - n.key) * rowHeight,
      height: Math.max(2, rowHeight - 1),
      opacity: 0.35 + 0.65 * n.velocity,
    }));
  }, [notes, lengthTicks]);
  const bars: number[] = [];
  for (let tick = 0; tick < lengthTicks; tick += barTicks) bars.push((tick / Math.max(1, lengthTicks)) * WIDTH);
  return (
    <svg className={styles.roll} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${notes.length} notes`}>
      {bars.map((x, i) => (
        <line key={i} x1={x} x2={x} y1={0} y2={HEIGHT} className={styles.rollBar} />
      ))}
      {drawn.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.width} height={r.height} rx={1} className={styles.rollNote} opacity={r.opacity} />
      ))}
    </svg>
  );
}
