import { memo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { editMixGroup, pickGroupMembers } from '@app/actions/mix-groups';
import { formatGain } from '@core/model/fader';
import { targetKey } from '@core/model/targets';
import type { GroupId } from '@core/model/types';
import { setVcaLevel } from '@core/ops/groups';
import { findGroup } from '@core/query/mix-groups';
import { showContextMenu } from '../../controls/ContextMenu';
import { useGestureEdit } from '../../edit';
import { useDoc, useServices } from '../../services-context';
import { Fader } from './Fader';
import { groupMenuEntries } from './group-menu';
import { RenameInput } from './RenameInput';
import styles from './Mixer.module.css';

/**
 * The strip of a group's VCA: one fader that turns every track of the group up or down in dB without moving their own
 * faders. It can be automated (right-click the fader) like any other fader, and its menu is the group's menu.
 */
export const VcaStrip = memo(function VcaStrip({ groupId }: { groupId: GroupId }) {
  const services = useServices();
  const group = useDoc((project) => findGroup(project.mixer, groupId));
  const [isRenaming, setIsRenaming] = useState(false);
  const edit = useGestureEdit<number>(
    `VCA ${group?.name ?? ''}`,
    (draft, gain) => setVcaLevel(draft, groupId, gain),
    `vca:${groupId}`,
  );
  if (!group || group.vca === undefined) return null;
  const level = group.vca;
  const memberNames = group.members.map((id) => services.doc.getState().project.mixer.inserts[id]?.name ?? '').filter(Boolean);
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    showContextMenu(event, groupMenuEntries(services, groupId, () => setIsRenaming(true)));
  };
  const finishRename = (value: string) => {
    setIsRenaming(false);
    const name = value.trim();
    if (name && name !== group.name) editMixGroup(services, groupId, { name }, `Rename group ${group.name}`);
  };
  return (
    <div
      className={`${styles.strip} ${styles.vcaStrip}`}
      style={{ ['--ins-color' as string]: group.color, ['--group-color' as string]: group.color }}
      onContextMenu={openMenu}
      onClick={() => pickGroupMembers(services, groupId)}
      data-hint={`VCA of the group “${group.name}” (${memberNames.join(', ')}): it scales their levels in dB without moving their faders. Click to pick the group, right-click for its settings`}
    >
      <span className={styles.stripNumber}>VCA</span>
      {isRenaming ? (
        <RenameInput initialName={group.name} onDone={finishRename} />
      ) : (
        <div
          className={styles.stripName}
          onDoubleClick={() => setIsRenaming(true)}
          title={group.name}
          data-hint={`${group.name}. Double-click to rename`}
        >
          {group.name}
        </div>
      )}
      <div className={styles.meterFader} onClick={(event) => event.stopPropagation()}>
        <Fader
          value={level}
          label={`${group.name} VCA`}
          param={targetKey({ kind: 'vca', groupId })}
          {...edit}
        />
      </div>
      <span className={styles.stripDb}>{formatGain(level)}</span>
    </div>
  );
});
