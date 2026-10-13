import type { MouseEvent as ReactMouseEvent } from 'react';
import type { FxSlot, InsertId } from '@core/model/types';
import { MAX_FX_SLOTS, setFxSlotMix } from '@core/ops/mixer';
import { insertLabel } from '@core/query/mixer';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { addEffect, moveEffectBy, removeEffect, replaceEffect, toggleEffect } from '@app/actions/mixer';
import { useDoc, useServices } from '../../services-context';
import { usePluginDef } from '../../plugin-hooks';
import { useGestureEdit } from '../../edit';
import { showContextMenu } from '../../controls/ContextMenu';
import { effectMenu, openEffectEditor } from './menus';
import styles from './Mixer.module.css';

const MIX = p.float(0, 1, 1, { label: 'Mix', unit: '%' });

function SlotRow({ insertId, slot, index, count }: { insertId: InsertId; slot: FxSlot; index: number; count: number }) {
  const services = useServices();
  const def = usePluginDef(slot.plugin.pluginId);
  const mix = useGestureEdit<number>('Effect mix', (d, v) => setFxSlotMix(d, insertId, slot.id, v), `fxmix:${slot.id}`);
  const name = def?.name ?? slot.plugin.pluginId;

  const menu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    showContextMenu(at, [
      { label: 'Open editor', onSelect: () => openEffectEditor(services, insertId, slot.id) },
      {
        label: 'Replace…',
        onSelect: () =>
          showContextMenu(
            at,
            effectMenu(services, (id) => replaceEffect(services, insertId, slot.id, id), slot.plugin.pluginId),
          ),
      },
      { label: slot.enabled ? 'Bypass' : 'Enable', onSelect: () => toggleEffect(services, insertId, slot.id) },
      { kind: 'separator' },
      { label: 'Move up', disabled: index === 0, onSelect: () => moveEffectBy(services, insertId, slot.id, -1) },
      {
        label: 'Move down',
        disabled: index >= count - 1,
        onSelect: () => moveEffectBy(services, insertId, slot.id, 1),
      },
      { kind: 'separator' },
      { label: 'Remove', danger: true, onSelect: () => removeEffect(services, insertId, slot.id) },
    ]);
  };

  return (
    <div
      className={`${styles.slot} ${slot.enabled ? '' : styles.slotOff} ${def ? '' : styles.slotMissing}`}
      onDoubleClick={() => openEffectEditor(services, insertId, slot.id)}
      onContextMenu={menu}
      data-hint={
        def
          ? `${name}${slot.enabled ? '' : ' (bypassed)'}. Double-click to edit, right-click for options`
          : `"${slot.plugin.pluginId}" is not installed: audio passes through and its settings are kept`
      }
    >
      <span className={styles.slotIndex}>{index + 1}</span>
      <button
        tabIndex={-1}
        className={`${styles.led} ${styles.slotLed} ${slot.enabled ? styles.ledOn : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => toggleEffect(services, insertId, slot.id)}
        data-hint={`${name}: ${slot.enabled ? 'on' : 'bypassed'}. Click to toggle`}
        aria-label={slot.enabled ? `Bypass ${name}` : `Enable ${name}`}
        aria-pressed={slot.enabled}
      />
      <span className={styles.slotName}>{name}</span>
      <Knob spec={MIX} value={slot.mix} size={18} label={`${name} mix`} {...mix} />
    </div>
  );
}

function EmptySlot({ insertId, index }: { insertId: InsertId; index: number }) {
  const services = useServices();
  const add = (e: ReactMouseEvent) => {
    e.preventDefault();
    showContextMenu(
      e,
      effectMenu(services, (pluginId) => {
        const slot = addEffect(services, insertId, pluginId);
        if (slot) openEffectEditor(services, insertId, slot);
      }),
    );
  };
  return (
    <button
      tabIndex={-1}
      className={`${styles.slot} ${styles.slotEmpty}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={add}
      onContextMenu={add}
      data-hint="Empty effect slot. Click to add an effect"
    >
      <span className={styles.slotIndex}>{index + 1}</span>
      <span className={styles.slotName}>(none)</span>
    </button>
  );
}

/** The selected insert's ten effect slots (FL's mixer track properties). */
export function FxRack({ insertId }: { insertId: InsertId }) {
  const insert = useDoc((pr) => pr.mixer.inserts[insertId]);
  const label = useDoc((pr) => insertLabel(pr, insertId));
  if (!insert) return null;
  const fx = insert.fx;
  return (
    <div className={styles.rack}>
      <div className={styles.rackHeader} data-hint="Effects run top to bottom on this insert">
        <span className={styles.rackLabel}>{label}</span>
        {insert.name !== label && <span className={styles.rackName}>{insert.name}</span>}
      </div>
      <div className={styles.slotList}>
        {Array.from({ length: MAX_FX_SLOTS }, (_, i) => {
          const slot = fx[i];
          return slot ? (
            <SlotRow key={slot.id} insertId={insertId} slot={slot} index={i} count={fx.length} />
          ) : (
            <EmptySlot key={`empty-${i}`} insertId={insertId} index={i} />
          );
        })}
      </div>
    </div>
  );
}
