import { Fragment, useEffect, useRef, useState } from 'react';
import { addMixerInsert } from '@app/actions/mixer';
import type { GroupId } from '@core/model/types';
import { vcaGroups } from '@core/query/mix-groups';
import { Icon } from '../../controls/Icon';
import { useWindowedRows } from '../../controls/windowed';
import { useDoc, useServices } from '../../services-context';
import { FxRack } from './FxRack';
import { MeterBank } from './meters';
import { MixerToolbar } from './MixerToolbar';
import { Strip } from './Strip';
import { useCurrentInsert } from './strip-controls';
import { VcaStrip } from './VcaStrip';
import styles from './Mixer.module.css';

/** One track strip and the gap after it, in pixels (`.strip` and `.strips` in Mixer.module.css). */
const STRIP_PITCH_PX = 62;
/** The gap between a strip and the next one, in pixels. */
const STRIP_GAP_PX = 4;
/** What sits left of the first track strip: the Master with its margin, the strips' padding and one gap. */
const MASTER_WIDTH_PX = 66 + 8 + 8 + STRIP_GAP_PX;
/** A mixer with this many strips or fewer shows them all; a longer one (a 100-track project) keeps the ones near the view. */
const WINDOWED_FROM_STRIPS = 40;
/** Strips drawn beyond each edge of the view, so the arrow keys have somewhere to go before the window moves. */
const STRIP_OVERSCAN = 10;

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
  // A long mixer draws only the strips near the view (the Master is always there); the spacers keep the scrollbar honest.
  const stripsRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(stripsRef, Math.max(0, order.length - 1), STRIP_PITCH_PX, {
    horizontal: true,
    overscan: STRIP_OVERSCAN,
    minRows: WINDOWED_FROM_STRIPS,
    leading: MASTER_WIDTH_PX + vcaGroupIds.length * STRIP_PITCH_PX,
  });
  const shown = order.length > 0 ? order.slice(0, 1).concat(order.slice(1 + win.first, 1 + win.last)) : order;
  const firstShown = (position: number) => (position === 0 ? 0 : win.first + position);
  const spacer = (width: number) => <div aria-hidden style={{ flex: 'none', width: Math.max(0, width - STRIP_GAP_PX) }} />;

  return (
    <div className={styles.mixer}>
      <div className={styles.mixerMain}>
        <MixerToolbar />
        {/* Every button of the strips (names, mutes, sends, groups) is one grid: one Tab stop, arrows move between strips. */}
        <div
          ref={stripsRef}
          className={styles.strips}
          onScroll={win.onScroll}
          onContextMenu={(event) => event.preventDefault()}
          role="group"
          aria-label="Mixer tracks"
          data-roving="grid"
        >
          {shown.map((id, position) => {
            const index = firstShown(position);
            return (
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
                {index === 0 && win.padTop > 0 && spacer(win.padTop)}
              </Fragment>
            );
          })}
          {win.padBottom > 0 && spacer(win.padBottom)}
          <button
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
