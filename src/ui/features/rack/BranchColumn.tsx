import { memo, useState, type DragEvent } from 'react';
import { RACK_PLUGIN_ID, branchCountRange } from '@core/model/rack';
import type { FxSlot, InsertId, MacroTarget, Rack, RackBranch } from '@core/model/types';
import { moveBranch, removeBranch, setBranch } from '@core/ops/racks';
import { BRANCH_LEVEL_SPEC, BRANCH_PAN_SPEC } from '@core/rack/mapping';
import { addEffectToBranch, moveEffectToBranch } from '@app/actions/racks';
import { Knob } from '@agstudio/sdk/ui';
import { useGestureEdit } from '../../edit';
import { showContextMenu } from '../../controls/ContextMenu';
import { effectMenu } from '../mixer/menus';
import { useServices } from '../../services-context';
import { EffectCard } from './EffectCard';
import { mapToMacroEntries } from './map-menu';
import { NameInput } from './NameInput';
import { canDropOnBranch, readDrop } from './rack-drag';
import styles from './Rack.module.css';

/** How many macro mappings point at an effect (its settings and its dry/wet). */
function macroCountOf(rack: Rack, slotId: string): number {
  let count = 0;
  for (const macro of rack.macros) {
    for (const mapping of macro.mappings) if ((mapping.target.kind === 'param' || mapping.target.kind === 'mix') && mapping.target.slotId === slotId) count++;
  }
  return count;
}

interface BranchProps {
  insertId: InsertId;
  slot: FxSlot & { rack: Rack };
  branch: RackBranch;
  index: number;
  /** Whether the branch sounds now (not muted, and not left out by a solo). */
  isAudible: boolean;
}

/** A knob with a right-click menu that maps it to a macro (the branch's own controls are not parameters of a plugin). */
function MappableKnob({ target, insertId, slot, children, name }: { target: MacroTarget; insertId: InsertId; slot: FxSlot; children: React.ReactNode; name: string }) {
  const services = useServices();
  return (
    <span
      className={styles.knobBox}
      onContextMenu={(event) => {
        event.preventDefault();
        showContextMenu(event, [{ kind: 'label', label: name }, ...mapToMacroEntries(services, insertId, slot.id, target)]);
      }}
    >
      {children}
    </span>
  );
}

/** One branch of the rack: name, mute and solo, level and pan, its effects as cards (a drop place for more), and a button to add one. */
export const BranchColumn = memo(function BranchColumn({ insertId, slot, branch, index, isAudible }: BranchProps) {
  const services = useServices();
  const [isRenaming, setIsRenaming] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const { rack } = slot;
  const range = branchCountRange(rack.split);
  const level = useGestureEdit<number>('Branch level', (draft, value) => void setBranch(draft, insertId, slot.id, branch.id, { levelDb: value }), `branch:${branch.id}:level`);
  const pan = useGestureEdit<number>('Branch pan', (draft, value) => void setBranch(draft, insertId, slot.id, branch.id, { pan: value }), `branch:${branch.id}:pan`);
  const edit = (label: string, settings: Parameters<typeof setBranch>[4]) => services.history.transact(label, (d) => void setBranch(d, insertId, slot.id, branch.id, settings));
  const others = rack.branches.filter((other) => other.id !== branch.id).map((other) => ({ id: other.id, name: other.name }));

  const menu = (event: { clientX: number; clientY: number }) =>
    showContextMenu(event, [
      { label: 'Rename…', onSelect: () => setIsRenaming(true) },
      { label: 'Add effect', onSelect: () => addMenu(event) },
      { kind: 'separator' },
      {
        label: 'Move left',
        disabled: rack.split !== 'parallel' || index === 0,
        hint: rack.split === 'parallel' ? 'Change the branch’s place' : 'In this split each branch means something by its place',
        onSelect: () => services.history.transact('Move branch', (d) => void moveBranch(d, insertId, slot.id, branch.id, index - 1)),
      },
      {
        label: 'Move right',
        disabled: rack.split !== 'parallel' || index >= rack.branches.length - 1,
        onSelect: () => services.history.transact('Move branch', (d) => void moveBranch(d, insertId, slot.id, branch.id, index + 1)),
      },
      { kind: 'separator' },
      {
        label: rack.split === 'bands' ? 'Merge this band into its neighbour' : 'Remove branch',
        danger: true,
        disabled: rack.branches.length <= range.min,
        hint: rack.branches.length <= range.min ? `A ${rack.split} rack needs at least ${range.min} branch${range.min === 1 ? '' : 'es'}` : 'Takes the branch and its effects out of the rack',
        onSelect: () => services.history.transact('Remove branch', (d) => void removeBranch(d, insertId, slot.id, branch.id)),
      },
    ]);

  const addMenu = (at: { clientX: number; clientY: number }) =>
    showContextMenu(at, effectMenu(services, (pluginId) => void addEffectToBranch(services, insertId, slot.id, branch.id, pluginId)).filter((entry) => !('label' in entry) || entry.label !== 'Rack'));

  const onDrop = (event: DragEvent, at: number) => {
    event.preventDefault();
    event.stopPropagation();
    setIsOver(false);
    const dropped = readDrop(event.dataTransfer);
    if (!dropped) return;
    if (dropped.kind === 'card') moveEffectToBranch(services, insertId, dropped.slotId, branch.id, at);
    else if (dropped.pluginId !== RACK_PLUGIN_ID) addEffectToBranch(services, insertId, slot.id, branch.id, dropped.pluginId, at);
  };
  const onDragOver = (event: DragEvent) => {
    if (!canDropOnBranch(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-agstudio-rack-fx') ? 'move' : 'copy';
    setIsOver(true);
  };
  /** Dropping on a card puts the effect before it (in its upper half) or after it. */
  const overCard = (event: DragEvent, at: number) => {
    onDragOver(event);
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    (event.currentTarget as HTMLElement).dataset.after = event.clientY > box.top + box.height / 2 ? 'yes' : 'no';
    void at;
  };
  const dropOnCard = (event: DragEvent, at: number) => onDrop(event, (event.currentTarget as HTMLElement).dataset.after === 'yes' ? at + 1 : at);

  return (
    <section
      className={`${styles.branch} ${isAudible ? '' : styles.branchSilent} ${isOver ? styles.branchDrop : ''}`}
      aria-label={`Branch ${branch.name}`}
      onDragOver={onDragOver}
      onDragLeave={() => setIsOver(false)}
      onDrop={(event) => onDrop(event, branch.fx.length)}
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        menu(event);
      }}
    >
      <div className={styles.branchHead}>
        <div className={styles.branchTop}>
          {isRenaming ? (
            <NameInput
              initialName={branch.name}
              label={`Name of the branch ${branch.name}`}
              onDone={(name) => {
                setIsRenaming(false);
                if (name.trim() && name.trim() !== branch.name) edit('Rename branch', { name });
              }}
            />
          ) : (
            <button
              className={styles.branchName}
              onDoubleClick={() => setIsRenaming(true)}
              onClick={(event) => menu(event)}
              aria-haspopup="menu"
              aria-label={`Branch ${branch.name}: options`}
              data-hint={`${branch.name}${isAudible ? '' : ' (silent: muted, or another branch is soloed)'}. Click for options (rename, move, remove); double-click to rename`}
            >
              {branch.name}
            </button>
          )}
          <button
            className={`${styles.button} ${branch.muted ? styles.buttonOn : ''}`}
            aria-pressed={branch.muted}
            aria-label={`Mute ${branch.name}`}
            data-hint={`Mute ${branch.name}: it stops sounding and stops using the processor. The rack keeps its timing`}
            onClick={() => edit('Mute branch', { muted: !branch.muted })}
          >
            M
          </button>
          <button
            className={`${styles.button} ${branch.solo ? styles.buttonOn : ''}`}
            aria-pressed={branch.solo}
            aria-label={`Solo ${branch.name}`}
            data-hint={`Solo ${branch.name}: only soloed branches sound`}
            onClick={() => edit('Solo branch', { solo: !branch.solo })}
          >
            S
          </button>
        </div>
        <div className={styles.branchKnobs}>
          <MappableKnob target={{ kind: 'branch', branchId: branch.id, param: 'level' }} insertId={insertId} slot={slot} name={`${branch.name} · Level`}>
            <Knob spec={BRANCH_LEVEL_SPEC} value={branch.levelDb} size={24} label={`${branch.name} level`} {...level} />
            <span aria-hidden>Level</span>
          </MappableKnob>
          <MappableKnob target={{ kind: 'branch', branchId: branch.id, param: 'pan' }} insertId={insertId} slot={slot} name={`${branch.name} · Pan`}>
            <Knob spec={BRANCH_PAN_SPEC} value={branch.pan} size={24} bipolar label={`${branch.name} pan`} {...pan} />
            <span aria-hidden>Pan</span>
          </MappableKnob>
        </div>
      </div>
      <div className={styles.cards} role="group" aria-label={`Effects of ${branch.name}`}>
        {branch.fx.length === 0 && (
          <p className={styles.emptyBranch}>
            {rack.branches.length > 1 ? 'Empty: the sound passes through untouched (the dry sound). ' : 'Empty. '}
            Add an effect below, or drag one here from the browser.
          </p>
        )}
        {branch.fx.map((effect, at) => (
          <EffectCard
            key={effect.id}
            insertId={insertId}
            slot={effect}
            branch={branch}
            otherBranches={others}
            index={at}
            count={branch.fx.length}
            macroCount={macroCountOf(rack, effect.id)}
            onDragOverCard={overCard}
            onDropOnCard={dropOnCard}
          />
        ))}
      </div>
      <button className={styles.add} onClick={(event) => addMenu(event)} aria-haspopup="menu" aria-label={`Add an effect to ${branch.name}`} data-hint={`Add an effect to ${branch.name} (it goes last)`}>
        + Add effect
      </button>
    </section>
  );
});
