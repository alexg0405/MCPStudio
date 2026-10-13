import { faderToGain, formatGain, gainToFader, UNITY_POSITION } from '@core/model/fader';
import { MASTER } from '@core/model/types';
import { setInsertProp } from '@core/ops/mixer';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { useDoc } from '../../services-context';
import { useGestureEdit } from '../../edit';
import styles from './Mixer.module.css';

/** Knob travel is the fader taper (0 dB at 80%), so it moves like the master fader. */
const TRAVEL = p.float(0, 1, UNITY_POSITION, { label: 'Master volume' });
const format = (pos: unknown) => formatGain(faderToGain(Number(pos)));

/** Toolbar knob for the master insert's volume (same document value as the master fader). */
export function MasterVolume() {
  const volume = useDoc((pr) => pr.mixer.inserts[MASTER]?.volume ?? 1);
  const edit = useGestureEdit<number>(
    'Master volume',
    (d, pos) => setInsertProp(d, MASTER, 'volume', faderToGain(pos)),
    `insvol:${MASTER}`,
  );
  return (
    <div className={styles.masterVolume}>
      <Knob spec={TRAVEL} value={gainToFader(volume)} size={26} label="Master volume" format={format} {...edit} />
      <span className={styles.masterLabel}>
        MASTER
        <span className={styles.masterValue}>{formatGain(volume)}</span>
      </span>
    </div>
  );
}
