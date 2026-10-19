import { groupPickedTracks, linkPickedTracks } from '@app/actions/mix-groups';
import { saveMixSnapshot, toggleCompare } from '@app/actions/mix-snapshots';
import { useDoc, useServices, useSession, useView } from '../../services-context';
import { toggleWindow } from '../../workspace/registry';
import styles from './Mixer.module.css';

const PICK_HINT = 'Pick two or more tracks first: Shift-click or Ctrl-click their strips';

/**
 * The row above the strips: save and compare mixer snapshots, and group or link the picked tracks. Everything here is
 * also in the menus and the action search; the buttons are the quick way while mixing.
 */
export function MixerToolbar() {
  const services = useServices();
  const pickedCount = useSession((session) => session.markedInsertIds.length);
  const compare = useSession((session) => session.snapshotCompare);
  const hasPair = useDoc((project) => {
    const snapshots = project.mixSnapshots ?? [];
    return snapshots.some((x) => x.id === compare.a) && snapshots.some((x) => x.id === compare.b);
  });
  const hasGroups = useDoc((project) => !!project.mixer.groups?.length);
  const canGroup = pickedCount >= 2;
  const isPanelOpen = useView((view) => !!view.windows['mix-snapshots']?.visible);
  const note = canGroup
    ? `${pickedCount} tracks picked`
    : hasGroups
      ? 'Shift-click strips to pick tracks'
      : 'Shift-click strips to pick tracks, then Group or Link selected: faders, pans, mutes and solos move together';

  return (
    <div className={styles.toolbar}>
      <button
        className={`${styles.toolButton} ${isPanelOpen ? styles.toolButtonOn : ''}`}
        onClick={() => toggleWindow(services, 'mix-snapshots')}
        data-hint="Mixer snapshots: save the mix, recall it later (one undo step), compare two while the song plays"
      >
        Snapshots
      </button>
      <button
        className={styles.toolButton}
        onClick={() => void saveMixSnapshot(services)}
        data-hint="Save the faders, pans, mutes, sends and effect settings as they are now as a new snapshot (notes and arrangement are not touched)"
      >
        Save
      </button>
      <button
        className={`${styles.toolButton} ${hasPair && compare.side ? styles.toolButtonOn : ''}`}
        disabled={!hasPair}
        onClick={() => toggleCompare(services)}
        data-hint={
          hasPair
            ? `Switch between snapshot A and B now (faders glide over 30 ms, so it does not click while the song plays). Now: ${compare.side ? compare.side.toUpperCase() : 'neither'}`
            : 'A/B compare: open Snapshots and press A on one snapshot and B on another, then switch between them here'
        }
      >
        A/B{hasPair && compare.side ? `: ${compare.side.toUpperCase()}` : ''}
      </button>
      <button
        className={styles.toolButton}
        disabled={!canGroup}
        onClick={() => void groupPickedTracks(services)}
        data-hint={canGroup ? 'Make a group of the picked tracks: faders, pans, mutes and solos move together, with a colour and an optional VCA' : PICK_HINT}
      >
        Group
      </button>
      <button
        className={styles.toolButton}
        disabled={!canGroup}
        onClick={() => void linkPickedTracks(services)}
        data-hint={canGroup ? 'Quick link: join the picked tracks into one group (the first one’s group, or a new one)' : PICK_HINT}
      >
        Link selected
      </button>
      <span className={styles.toolNote}>{note}</span>
    </div>
  );
}
