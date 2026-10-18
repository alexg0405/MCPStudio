import { useEffect, useState } from 'react';
import { addMixerInsert } from '@app/actions/mixer';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import { FxRack } from './FxRack';
import { MeterBank } from './meters';
import { Strip } from './Strip';
import { useCurrentInsert } from './strip-controls';
import styles from './Mixer.module.css';

/** FL-style mixer: master + insert strips on the left, the selected insert's effect slots on the right. */
export function Mixer() {
  const services = useServices();
  const order = useDoc((project) => project.mixer.order);
  const current = useCurrentInsert();
  const [meters] = useState(() => new MeterBank());
  useEffect(() => meters.start(services), [meters, services]);

  return (
    <div className={styles.mixer}>
      <div className={styles.strips} onContextMenu={(event) => event.preventDefault()}>
        {order.map((id, index) => (
          <Strip
            key={id}
            id={id}
            index={index}
            isLast={index === order.length - 1}
            isSelected={id === current}
            meters={meters}
          />
        ))}
        <button
          tabIndex={-1}
          className={styles.addInsert}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => addMixerInsert(services)}
          data-hint="Add a mixer track (insert)"
          aria-label="Add a mixer insert"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <FxRack insertId={current} />
    </div>
  );
}
