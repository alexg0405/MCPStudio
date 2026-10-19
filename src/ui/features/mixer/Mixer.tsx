import { Fragment, useEffect, useState } from 'react';
import { addMixerInsert } from '@app/actions/mixer';
import type { GroupId } from '@core/model/types';
import { vcaGroups } from '@core/query/mix-groups';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import { FxRack } from './FxRack';
import { MeterBank } from './meters';
import { MixerToolbar } from './MixerToolbar';
import { Strip } from './Strip';
import { useCurrentInsert } from './strip-controls';
import { VcaStrip } from './VcaStrip';
import styles from './Mixer.module.css';

/** The ids of the groups that have a VCA, as one string so the mixer re-renders only when that list changes. */
function useVcaGroupIds(): GroupId[] {
  const joined = useDoc((project) => vcaGroups(project.mixer).map((group) => group.id).join(','));
  return joined ? (joined.split(',') as GroupId[]) : [];
}

/** FL-style mixer: master + insert strips on the left, the selected insert's effect slots on the right. */
export function Mixer() {
  const services = useServices();
  const order = useDoc((project) => project.mixer.order);
  const vcaGroupIds = useVcaGroupIds();
  const current = useCurrentInsert();
  const [meters] = useState(() => new MeterBank());
  useEffect(() => meters.start(services), [meters, services]);

  return (
    <div className={styles.mixer}>
      <div className={styles.mixerMain}>
        <MixerToolbar />
        <div className={styles.strips} onContextMenu={(event) => event.preventDefault()}>
          {order.map((id, index) => (
            <Fragment key={id}>
              <Strip
                id={id}
                index={index}
                isLast={index === order.length - 1}
                isSelected={id === current}
                meters={meters}
              />
              {/* The VCA faders sit right after the Master, where they are found without scrolling. */}
              {index === 0 && vcaGroupIds.map((groupId) => <VcaStrip key={groupId} groupId={groupId} />)}
            </Fragment>
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
      </div>
      <FxRack insertId={current} />
    </div>
  );
}
