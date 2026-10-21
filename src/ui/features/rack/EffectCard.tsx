import { memo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { targetKey } from '@core/model/targets';
import type { BranchId, FxSlot, InsertId, RackBranch, SlotId } from '@core/model/types';
import { setFxSlotMix } from '@core/ops/mixer';
import { p } from '@agstudio/sdk';
import { Knob } from '@agstudio/sdk/ui';
import { moveEffectToBranch } from '@app/actions/racks';
import { removeEffect, toggleEffect } from '@app/actions/mixer';
import { useGestureEdit } from '../../edit';
import { showContextMenu } from '../../controls/ContextMenu';
import { usePluginDef } from '../../plugin-hooks';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { startCardDrag } from './rack-drag';
import styles from './Rack.module.css';

const MIX = p.float(0, 1, 1, { label: 'Mix', unit: '%' });

export interface EffectCardProps {
  insertId: InsertId;
  slot: FxSlot;
  branch: RackBranch;
  /** The other branches of the rack (to move the effect to). */
  otherBranches: readonly { id: BranchId; name: string }[];
  index: number;
  count: number;
  /** How many things a macro moves in this effect (its settings and its dry/wet). */
  macroCount: number;
  /** A drag came over (or was dropped on) this card: the caller puts the dragged effect before or after it. */
  onDragOverCard(event: DragEvent, index: number): void;
  onDropOnCard(event: DragEvent, index: number): void;
}

/** One effect in a branch: bypass light, name (opens its editor), dry/wet, a menu, and a handle to drag it to another branch. */
export const EffectCard = memo(function EffectCard({ insertId, slot, branch, otherBranches, index, count, macroCount, onDragOverCard, onDropOnCard }: EffectCardProps) {
  const services = useServices();
  const def = usePluginDef(slot.plugin.pluginId);
  const [isDragging, setIsDragging] = useState(false);
  const name = def?.name ?? slot.plugin.pluginId;
  const mix = useGestureEdit<number>('Effect mix', (draft, value) => setFxSlotMix(draft, insertId, slot.id, value), `fxmix:${slot.id}`);
  const open = () => openWindow(services, 'plugin', { kind: 'fx', insertId, slotId: slot.id as SlotId });

  const menu = (event: { clientX: number; clientY: number }) =>
    showContextMenu(event, [
      { label: 'Open editor', onSelect: open, hint: `Open ${name}’s own window. Right-click its knobs to map them to a macro` },
      { label: slot.enabled ? 'Bypass' : 'Enable', onSelect: () => toggleEffect(services, insertId, slot.id) },
      { kind: 'separator' },
      { label: 'Move up', disabled: index === 0, onSelect: () => moveEffectToBranch(services, insertId, slot.id, branch.id, index - 1) },
      { label: 'Move down', disabled: index >= count - 1, onSelect: () => moveEffectToBranch(services, insertId, slot.id, branch.id, index + 1) },
      {
        kind: 'submenu',
        label: 'Move to branch',
        disabled: otherBranches.length === 0,
        hint: 'Put this effect in another branch of the rack (you can also drag it there)',
        items: () => otherBranches.map((other) => ({ label: other.name, onSelect: () => moveEffectToBranch(services, insertId, slot.id, other.id, Number.MAX_SAFE_INTEGER) })),
      },
      { kind: 'separator' },
      { label: 'Remove', danger: true, onSelect: () => removeEffect(services, insertId, slot.id) },
    ]);

  return (
    <div
      className={`${styles.card} ${slot.enabled ? '' : styles.cardOff} ${isDragging ? styles.cardDragging : ''}`}
      draggable
      onDragStart={(event) => {
        startCardDrag(event, insertId, slot.id);
        setIsDragging(true);
      }}
      onDragEnd={() => setIsDragging(false)}
      onDragOver={(event) => onDragOverCard(event, index)}
      onDrop={(event) => onDropOnCard(event, index)}
      onContextMenu={(event: ReactMouseEvent) => {
        event.preventDefault();
        menu(event);
      }}
      data-hint={`${name}${slot.enabled ? '' : ' (bypassed)'}. Click the name to open it, drag the card to another branch, right-click for more`}
    >
      <button
        className={`${styles.led} ${slot.enabled ? styles.ledOn : ''}`}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => toggleEffect(services, insertId, slot.id)}
        aria-label={`Enable ${name}`}
        aria-pressed={slot.enabled}
        data-hint={`${name}: ${slot.enabled ? 'on' : 'bypassed (the sound passes through untouched)'}. Click to ${slot.enabled ? 'bypass' : 'turn it on'}`}
      />
      <button className={styles.cardName} onClick={open} aria-label={`Open the editor of ${name}`} data-hint={`Open ${name}`}>
        {name}
      </button>
      {macroCount > 0 && (
        <span className={styles.mapped} data-hint={`${macroCount} of its settings are moved by a macro`} aria-label={`${macroCount} settings moved by macros`}>
          ◆ {macroCount}
        </span>
      )}
      <Knob spec={MIX} value={slot.mix} size={18} label={`${name} dry/wet`} param={targetKey({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' })} {...mix} />
      <button className={styles.button} onClick={(event) => menu(event)} aria-label={`More for ${name}`} aria-haspopup="menu" data-hint={`Open, bypass, move or remove ${name}`}>
        ⋯
      </button>
    </div>
  );
});
