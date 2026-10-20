import { memo, type MouseEvent as ReactMouseEvent } from 'react';
import { pickGroupMembers } from '@app/actions/mix-groups';
import { formatGain } from '@core/model/fader';
import type { InsertId } from '@core/model/types';
import { groupOfInsert } from '@core/query/mix-groups';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import { groupMenuEntries } from './group-menu';
import styles from './Mixer.module.css';

/**
 * The coloured band on top of a grouped track's strip: the group's name in its colour. Click it to pick every track
 * of the group, right-click for the group's menu. A strip outside any group keeps an empty slot so strips line up.
 */
export const GroupBand = memo(function GroupBand({ id }: { id: InsertId }) {
  const services = useServices();
  const group = useDoc((project) => groupOfInsert(project.mixer, id));
  if (!group) return <span className={styles.groupSlot} />;
  const vcaNote = group.vca === undefined ? '' : ` Its VCA is at ${formatGain(group.vca)}.`;
  const linked = (['volume', 'pan', 'mute', 'solo'] as const).filter((control) => group.links[control]);
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event, groupMenuEntries(services, group.id));
  };
  return (
    <button
      className={styles.groupBand}
      style={{ ['--group-color' as string]: group.color }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => pickGroupMembers(services, group.id)}
      onContextMenu={openMenu}
      data-hint={`Group “${group.name}” (${group.members.length} tracks; ${linked.length ? `${linked.join(', ')} linked, ${group.mode}` : 'nothing linked'}).${vcaNote} Click to pick all its tracks, right-click for its settings`}
      aria-label={`Group ${group.name}`}
    >
      {group.name}
    </button>
  );
});
