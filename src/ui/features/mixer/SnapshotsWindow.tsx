import { memo, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  deleteMixSnapshot,
  recallMixSnapshot,
  renameMixSnapshot,
  saveMixSnapshot,
  setCompareSlot,
  snapshotDifferences,
  snapshotDifferencesBetween,
  toggleCompare,
  updateMixSnapshot,
} from '@app/actions/mix-snapshots';
import type { MixSnapshot, SnapshotId } from '@core/model/types';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices, useSession } from '../../services-context';
import { RenameInput } from './RenameInput';
import styles from './Snapshots.module.css';

/** "just now", "3 min ago", "2 h ago". */
function ago(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** The sentences of a difference list, or the line that says there is none. */
function DifferenceList({ lines, none }: { lines: readonly string[]; none: string }) {
  if (lines.length === 0) return <div className={styles.same}>{none}</div>;
  return (
    <ul className={styles.diff}>
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

/** What recalling a snapshot would change, kept up to date while the mix moves. */
function SnapshotDifferences({ id, name }: { id: SnapshotId; name: string }) {
  const services = useServices();
  useDoc((project) => project);
  const lines = snapshotDifferences(services, id).map((difference) => difference.text);
  return <DifferenceList lines={lines} none={`The mix already matches “${name}”.`} />;
}

interface RowProps {
  snapshot: MixSnapshot;
  isA: boolean;
  isB: boolean;
  isExpanded: boolean;
  now: number;
  onToggleExpanded(id: SnapshotId): void;
}

const SnapshotRow = memo(function SnapshotRow({ snapshot, isA, isB, isExpanded, now, onToggleExpanded }: RowProps) {
  const services = useServices();
  const [isRenaming, setIsRenaming] = useState(false);
  const { id, name } = snapshot;
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    showContextMenu(event, [
      { label: 'Recall', hint: `Put the mix back to “${name}” (one undo step)`, onSelect: () => void recallMixSnapshot(services, id) },
      {
        label: 'Update with the mix as it is now',
        hint: `Replace what “${name}” holds with the current faders, pans, mutes, sends and effect settings`,
        onSelect: () => void updateMixSnapshot(services, id),
      },
      { label: 'Rename…', onSelect: () => setIsRenaming(true) },
      { label: 'Show what is different', hint: 'List what recalling it would change', onSelect: () => onToggleExpanded(id) },
      { kind: 'separator' },
      { label: 'Delete', danger: true, onSelect: () => deleteMixSnapshot(services, id) },
    ]);
  };
  return (
    <li className={`${styles.row} ${isExpanded ? styles.rowOpen : ''}`} onContextMenu={openMenu}>
      <div className={styles.rowTop}>
        {isRenaming ? (
          <RenameInput
            initialName={name}
            onDone={(value) => {
              setIsRenaming(false);
              renameMixSnapshot(services, id, value);
            }}
          />
        ) : (
          <button
            className={styles.name}
            onClick={() => void recallMixSnapshot(services, id)}
            onDoubleClick={() => setIsRenaming(true)}
            data-hint={`${name}${snapshot.routing ? ' (with routing)' : ''}, saved ${ago(now - snapshot.savedAt)}. Click to recall it (one undo step); double-click to rename`}
          >
            <span className={styles.nameText}>{name}</span>
            <span className={styles.time}>
              {snapshot.routing ? 'with routing · ' : ''}
              {ago(now - snapshot.savedAt)}
            </span>
          </button>
        )}
        <button
          className={`${styles.slot} ${isA ? styles.slotOn : ''}`}
          aria-pressed={isA}
          onClick={() => setCompareSlot(services, 'a', isA ? null : id)}
          data-hint={isA ? `“${name}” is A of the A/B compare. Click to clear` : `Make “${name}” snapshot A of the A/B compare`}
        >
          A
        </button>
        <button
          className={`${styles.slot} ${isB ? styles.slotOn : ''}`}
          aria-pressed={isB}
          onClick={() => setCompareSlot(services, 'b', isB ? null : id)}
          data-hint={isB ? `“${name}” is B of the A/B compare. Click to clear` : `Make “${name}” snapshot B of the A/B compare`}
        >
          B
        </button>
        <button
          className={styles.small}
          onClick={() => onToggleExpanded(id)}
          aria-expanded={isExpanded}
          data-hint={`What is different between the mix now and “${name}”`}
        >
          Diff
        </button>
        <button className={styles.small} onClick={openMenu} data-hint="Update, rename or delete this snapshot" aria-label={`More for ${name}`}>
          ⋯
        </button>
      </div>
      {isExpanded && <SnapshotDifferences id={id} name={name} />}
    </li>
  );
});

/** Between snapshot A and B: what switching changes. */
function CompareDifferences({ a, b }: { a: MixSnapshot; b: MixSnapshot }) {
  const services = useServices();
  const lines = snapshotDifferencesBetween(services, a.id, b.id).map((difference) => difference.text);
  return <DifferenceList lines={lines} none={`“${a.name}” and “${b.name}” hold the same mix.`} />;
}

/**
 * Mixer snapshots: save the mix as it is (faders, pans, mutes, solos, sends, effect settings, VCA levels, and the routing
 * if you ask), recall one later in one undo step, and compare two with an A/B switch while the song plays. A snapshot
 * never holds notes or the arrangement, so recalling one never changes what is played, only how it is mixed.
 */
export function SnapshotsWindow() {
  const services = useServices();
  const snapshots = useDoc((project) => project.mixSnapshots);
  const compare = useSession((session) => session.snapshotCompare);
  const [withRouting, setWithRouting] = useState(false);
  const [expanded, setExpanded] = useState<SnapshotId | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const list = snapshots ?? [];
  const a = list.find((snapshot) => snapshot.id === compare.a);
  const b = list.find((snapshot) => snapshot.id === compare.b);
  const toggleExpanded = (id: SnapshotId) => setExpanded((open) => (open === id ? null : id));

  return (
    <div className={styles.wrap}>
      <div className={styles.help}>
        A snapshot remembers the mixer’s values: faders, pans, mutes, solos, sends and effect settings. Recall one any time (one undo step); notes and the arrangement are never touched.
      </div>
      <div className={styles.bar}>
        <button
          className={styles.primary}
          onClick={() => void saveMixSnapshot(services, { routing: withRouting })}
          data-hint="Save the mixer as it is now as a new snapshot"
        >
          Save snapshot
        </button>
        <label className={styles.check} data-hint="Also remember which tracks send to which, and the effects’ sidechain sources (recalling then restores the routing too)">
          <input type="checkbox" checked={withRouting} onChange={(event) => setWithRouting(event.currentTarget.checked)} />
          with routing
        </label>
        <button
          className={`${styles.primary} ${compare.side ? styles.primaryOn : ''}`}
          disabled={!a || !b}
          onClick={() => toggleCompare(services)}
          data-hint={
            a && b
              ? 'Switch between A and B right now (the faders glide over 30 ms, so it does not click while the song plays)'
              : 'Press A on one snapshot and B on another, then use this to switch between them while the song plays'
          }
        >
          A/B{compare.side && a && b ? `: playing ${compare.side.toUpperCase()}` : ''}
        </button>
      </div>
      {list.length === 0 ? (
        <div className={styles.empty}>
          <b>No snapshots yet.</b>
          <p>Set the mixer the way you like it, then press “Save snapshot”.</p>
          <p>Make another version, save it too, then press A on one and B on the other and switch between them while the song plays.</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {list.map((snapshot) => (
            <SnapshotRow
              key={snapshot.id}
              snapshot={snapshot}
              isA={compare.a === snapshot.id}
              isB={compare.b === snapshot.id}
              isExpanded={expanded === snapshot.id}
              now={now}
              onToggleExpanded={toggleExpanded}
            />
          ))}
        </ul>
      )}
      {a && b && (
        <div className={styles.between}>
          <div className={styles.betweenTitle}>
            Switching from “{a.name}” (A) to “{b.name}” (B) changes:
          </div>
          <CompareDifferences a={a} b={b} />
        </div>
      )}
    </div>
  );
}
