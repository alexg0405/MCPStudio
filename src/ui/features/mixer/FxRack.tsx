import { targetKey } from '@core/model/targets';
import { memo, useCallback, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import type { FxSlot, InsertId } from '@core/model/types';
import { MAX_FX_SLOTS, setFxSlotMix } from '@core/ops/mixer';
import { insertLabel } from '@core/query/mixer';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { addEffect, moveEffectBy, removeEffect, replaceEffect, toggleEffect } from '@app/actions/mixer';
import { useDoc, useServices, useSession } from '../../services-context';
import { usePluginDef } from '../../plugin-hooks';
import { useGestureEdit } from '../../edit';
import { showContextMenu } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { effectMenu, openEffectEditor } from './menus';
import { insertName } from './routing';
import styles from './Mixer.module.css';

const MIX = p.float(0, 1, 1, { label: 'Mix', unit: '%' });

/** The mixer's delay compensation in seconds (re-renders when it changes). */
function useGraphLatency(): number {
  const { engine } = useServices();
  const subscribe = useCallback((fn: () => void) => engine.subscribe(fn), [engine]);
  return useSyncExternalStore(subscribe, () => engine.graphLatency());
}

const SlotRow = memo(function SlotRow({
  insertId,
  slot,
  index,
  count,
}: {
  insertId: InsertId;
  slot: FxSlot;
  index: number;
  count: number;
}) {
  const services = useServices();
  const def = usePluginDef(slot.plugin.pluginId);
  const mix = useGestureEdit<number>('Effect mix', (draft, value) => setFxSlotMix(draft, insertId, slot.id, value), `fxmix:${slot.id}`);
  const name = def?.name ?? slot.plugin.pluginId;
  const rack = slot.rack;
  const rackNote = rack ? (rack.branches.length === 1 ? 'chain' : `${rack.branches.length} ${rack.split === 'bands' ? 'bands' : rack.split === 'parallel' ? 'branches' : rack.split === 'midside' ? 'mid/side' : 'left/right'}`) : '';
  const listens = def?.kind === 'effect' && !!def.sidechain;
  const isMarked = useSession((session) => session.markedSlotIds.includes(slot.id));
  const keyName = useDoc((project) =>
    slot.sidechain && project.mixer.inserts[slot.sidechain] ? insertName(project, slot.sidechain) : null,
  );

  const menu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    showContextMenu(at, [
      { label: rack ? 'Open rack' : 'Open editor', onSelect: () => openEffectEditor(services, insertId, slot.id) },
      {
        kind: 'submenu',
        label: 'Replace with',
        items: () => effectMenu(services, (id) => replaceEffect(services, insertId, slot.id, id), slot.plugin.pluginId),
      },
      { label: slot.enabled ? 'Bypass' : 'Enable', onSelect: () => toggleEffect(services, insertId, slot.id) },
      { kind: 'separator' },
      { label: 'Move up', disabled: index === 0, onSelect: () => moveEffectBy(services, insertId, slot.id, -1) },
      {
        label: 'Move down',
        disabled: index >= count - 1,
        onSelect: () => moveEffectBy(services, insertId, slot.id, 1),
      },
      ...extraMenuItems('mixer.slot', { insertId, slotId: slot.id }, services),
      { kind: 'separator' },
      { label: 'Remove', danger: true, onSelect: () => removeEffect(services, insertId, slot.id) },
    ]);
  };

  return (
    <div
      className={`${styles.slot} ${slot.enabled ? '' : styles.slotOff} ${def ? '' : styles.slotMissing} ${isMarked ? styles.slotMarked : ''}`}
      onDoubleClick={() => openEffectEditor(services, insertId, slot.id)}
      onContextMenu={menu}
      data-hint={
        def
          ? `${rack ? `Effect rack (${rackNote})` : name}${slot.enabled ? '' : ' (bypassed: audio passes through untouched)'}${listens ? (keyName ? `. Sidechain: reacts to “${keyName}”` : '. Sidechain: reacts to its own input') : ''}. Double-click to ${rack ? 'open it' : 'edit'}, right-click for options${listens ? ' (Sidechain from…)' : rack ? ' (Ungroup, Save as my rack…)' : ' (Group into a rack…)'}. Ctrl- or Shift-click marks it for grouping`
          : `"${slot.plugin.pluginId}" is not installed: audio passes through and its settings are kept`
      }
    >
      <span className={styles.slotIndex}>{index + 1}</span>
      <button
        className={`${styles.led} ${styles.slotLed} ${slot.enabled ? styles.ledOn : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => toggleEffect(services, insertId, slot.id)}
        data-hint={`${name}: ${slot.enabled ? 'on' : 'bypassed (audio passes through untouched)'}. Click to ${slot.enabled ? 'bypass' : 'turn it on'}`}
        aria-label={`Enable ${name}`}
        aria-pressed={slot.enabled}
      />
      <span
        className={styles.slotName}
        role="button"
        tabIndex={0}
        aria-label={`Open the editor of ${name}`}
        aria-pressed={isMarked || undefined}
        onClick={(e) => {
          // Ctrl, Cmd or Shift marks the slot for "Group into a rack".
          if (e.ctrlKey || e.metaKey || e.shiftKey) services.session.getState().toggleMarkedSlot(slot.id);
        }}
        onKeyDown={(e) => {
          // The keyboard's double-click (the menu key or Shift+F10 opens the slot's menu).
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openEffectEditor(services, insertId, slot.id);
        }}
      >
        {name}
        {rack && <span className={styles.slotRack}> · {rackNote}</span>}
      </span>
      {listens && keyName && (
        <span
          className={styles.slotKey}
          data-hint={`${name} reacts to “${keyName}” (sidechain). Right-click to change`}
        >
          SC: {keyName}
        </span>
      )}
      <Knob
        spec={MIX}
        value={slot.mix}
        size={18}
        label={`${name} dry/wet`}
        param={targetKey({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' })}
        {...mix}
      />
    </div>
  );
});

const EmptySlot = memo(function EmptySlot({
  insertId,
  index,
  first,
}: {
  insertId: InsertId;
  index: number;
  first: boolean;
}) {
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
      className={`${styles.slot} ${styles.slotEmpty}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={add}
      onContextMenu={add}
      data-hint="Empty effect slot. Click to add an effect"
      aria-label={`Add an effect to slot ${index + 1}`}
      aria-haspopup="menu"
    >
      <span className={styles.slotIndex}>{index + 1}</span>
      {/* Only the next free slot says it out loud; the rest stay quiet. */}
      <span className={styles.slotName}>{first ? '+ Add effect' : ''}</span>
    </button>
  );
});

/** The selected insert's ten effect slots (FL's mixer track properties). */
export function FxRack({ insertId }: { insertId: InsertId }) {
  // The slot list and the name, not the whole insert: dragging the track's fader changes the insert object on
  // every move, and nothing in the rack depends on its volume.
  const fx = useDoc((project) => project.mixer.inserts[insertId]?.fx);
  const insertNameNow = useDoc((project) => project.mixer.inserts[insertId]?.name);
  const label = useDoc((project) => insertLabel(project, insertId));
  const latency = useGraphLatency();
  if (!fx || insertNameNow === undefined) return null;
  const insert = { name: insertNameNow };
  const ms = (latency * 1000).toFixed(1);
  return (
    <div className={styles.rack}>
      <div className={styles.rackHeader} data-hint={`Effects on ${insert.name} run top to bottom`}>
        <span className={styles.rackLabel}>{label}</span>
        {insert.name !== label && <span className={styles.rackName}>{insert.name}</span>}
        {latency > 0 && (
          <span
            className={styles.pdc}
            data-hint={`Delay compensation: ${ms} ms. Some effects delay their audio (look-ahead, oversampling), so the mixer holds every other path back by the same amount and everything stays in time. The playhead accounts for it`}
          >
            Delay comp. {ms} ms
          </span>
        )}
      </div>
      <div className={styles.slotList} role="group" aria-label={`Effects of ${label}`} data-roving="grid">
        {Array.from({ length: MAX_FX_SLOTS }, (_, i) => {
          const slot = fx[i];
          return slot ? (
            <SlotRow key={slot.id} insertId={insertId} slot={slot} index={i} count={fx.length} />
          ) : (
            <EmptySlot key={`empty-${i}`} insertId={insertId} index={i} first={i === fx.length} />
          );
        })}
      </div>
    </div>
  );
}
