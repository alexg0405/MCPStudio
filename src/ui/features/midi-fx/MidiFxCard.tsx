import { memo, useCallback, type DragEvent, type KeyboardEvent } from 'react';
import { targetKey } from '@core/model/targets';
import type { ChannelId, MidiFxSlot } from '@core/model/types';
import { midiFxDef, slotValues } from '@core/midi-fx/registry';
import { moveMidiEffectBy, removeMidiEffect, toggleMidiEffect } from '@app/actions/midi-fx';
import { ParamMenuContext, ParamStatusContext, type ParamStatus } from '@agstudio/sdk/ui';
import type { ParamSpec } from '@agstudio/sdk/params';
import { showContextMenu } from '../../controls/ContextMenu';
import { showParamMenu } from '../../param-menu';
import { useServices } from '../../services-context';
import { AutoPanel } from '../plugin-window/AutoPanel';
import { presetEntries } from './menus';
import { useMidiFxEditing } from './use-midi-fx-editing';
import styles from './MidiFx.module.css';

/** What a drag of one effect over another says: the drop lands before it or after it. */
export type DropSide = 'before' | 'after';

/** The drag-and-drop of effects in a list: which one is being dragged and where it would land. */
export interface ReorderState {
  dragging: string | null;
  over: { slotId: string; side: DropSide } | null;
  start(slotId: string): void;
  hover(slotId: string, side: DropSide): void;
  drop(): void;
  cancel(): void;
}

/** The type of what a drag of an effect carries (so a file or text dropped on the list is not mistaken for one). */
export const DRAG_TYPE = 'application/x-agstudio-midifx';

interface CardProps {
  channelId: ChannelId;
  slot: MidiFxSlot;
  index: number;
  count: number;
  reorder: ReorderState;
}

/** One effect of the chain: bypass, name, presets, move and remove over its knobs. */
export const MidiFxCard = memo(function MidiFxCard({ channelId, slot, index, count, reorder }: CardProps) {
  const services = useServices();
  const def = midiFxDef(slot.effect);
  const edit = useMidiFxEditing(channelId, slot);
  const name = def?.name ?? slot.effect;

  const openParamMenu = useCallback(
    (param: string, at: { clientX: number; clientY: number }) => {
      const spec = def?.params[param] as ParamSpec | undefined;
      if (!def || !spec) return;
      showParamMenu(
        at,
        {
          target: { kind: 'midiFx', channelId, slotId: slot.id, paramId: param },
          spec,
          label: `${def.name} · ${spec.label ?? param}`,
          reset: () => edit.setParam(param, spec.default),
        },
        services,
      );
    },
    [def, channelId, slot.id, services, edit],
  );
  const status = useCallback(
    (param: string, cb: (s: ParamStatus | null) => void) =>
      services.automation.watch(targetKey({ kind: 'midiFx', channelId, slotId: slot.id, paramId: param }), cb),
    [services, channelId, slot.id],
  );

  const menu = (e: { clientX: number; clientY: number; preventDefault(): void }) => {
    e.preventDefault();
    showContextMenu(e, [
      { label: slot.enabled ? 'Bypass' : 'Turn on', onSelect: () => toggleMidiEffect(services, channelId, slot.id) },
      { label: 'Move earlier', disabled: index === 0, onSelect: () => moveMidiEffectBy(services, channelId, slot.id, -1) },
      { label: 'Move later', disabled: index >= count - 1, onSelect: () => moveMidiEffectBy(services, channelId, slot.id, 1) },
      { kind: 'separator' },
      ...presetEntries(services, channelId, slot),
      { kind: 'separator' },
      { label: 'Remove', danger: true, onSelect: () => removeMidiEffect(services, channelId, slot.id) },
    ]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    moveMidiEffectBy(services, channelId, slot.id, e.key === 'ArrowUp' ? -1 : 1);
  };

  const onDragOver = (e: DragEvent<HTMLLIElement>) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    reorder.hover(slot.id, e.clientY < box.top + box.height / 2 ? 'before' : 'after');
  };

  const drop = reorder.over?.slotId === slot.id ? reorder.over.side : null;
  const classes = [
    styles.card,
    slot.enabled ? '' : styles.cardOff,
    drop === 'before' ? styles.dropBefore : '',
    drop === 'after' ? styles.dropAfter : '',
    reorder.dragging === slot.id ? styles.dragging : '',
  ].join(' ');

  return (
    <li
      className={classes}
      aria-label={`${name}, effect ${index + 1} of ${count}${slot.enabled ? '' : ', bypassed'}`}
      onContextMenu={menu}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        reorder.drop();
      }}
    >
      <div
        className={styles.cardHeader}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, slot.id);
          e.dataTransfer.effectAllowed = 'move';
          reorder.start(slot.id);
        }}
        onDragEnd={reorder.cancel}
        onKeyDown={onKeyDown}
        data-hint={`${name}. Drag to change the order the notes go through the effects, right-click for more (Alt+Up and Alt+Down move it from the keyboard)`}
      >
        <span className={styles.handle} aria-hidden>
          ⋮⋮
        </span>
        <span className={styles.index} aria-hidden>
          {index + 1}
        </span>
        <button
          type="button"
          className={`${styles.led} ${slot.enabled ? styles.ledOn : ''}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => toggleMidiEffect(services, channelId, slot.id)}
          aria-label={`Enable ${name}`}
          aria-pressed={slot.enabled}
          data-hint={`${name} is ${slot.enabled ? 'on' : 'bypassed: notes pass through it unchanged'}. Click to ${slot.enabled ? 'bypass' : 'turn on'}`}
        />
        <span className={styles.name}>{name}</span>
        <span className={styles.description}>{def?.description ?? ''}</span>
        {def && (
          <button
            type="button"
            className={styles.presets}
            aria-haspopup="menu"
            aria-label={`${name} presets`}
            data-hint="Presets: load one, save your own, or reset"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              showContextMenu({ clientX: box.left, clientY: box.bottom + 2 }, presetEntries(services, channelId, slot));
            }}
          >
            Presets ▾
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          disabled={index === 0}
          onClick={() => moveMidiEffectBy(services, channelId, slot.id, -1)}
          aria-label={`Move ${name} earlier`}
          data-hint="Move this effect earlier in the chain"
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.iconButton}
          disabled={index >= count - 1}
          onClick={() => moveMidiEffectBy(services, channelId, slot.id, 1)}
          aria-label={`Move ${name} later`}
          data-hint="Move this effect later in the chain"
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => removeMidiEffect(services, channelId, slot.id)}
          aria-label={`Remove ${name}`}
          data-hint="Remove this effect from the chain"
        >
          ✕
        </button>
      </div>
      <div className={styles.cardBody}>
        {def ? (
          <ParamMenuContext.Provider value={openParamMenu}>
            <ParamStatusContext.Provider value={status}>
              <AutoPanel specs={def.params} values={slotValues(def, slot)} {...edit} />
            </ParamStatusContext.Provider>
          </ParamMenuContext.Provider>
        ) : (
          <p className={styles.unknown}>
            This version does not have an effect called “{slot.effect}”. Its settings are kept with the project, and notes pass
            through it unchanged.
          </p>
        )}
      </div>
    </li>
  );
});
