import { memo, useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PALETTE } from '@core/model/defaults';
import { formatGain } from '@core/model/fader';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { setInsertProp, toggleSoloInsert } from '@core/ops/mixer';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { addMixerInsert, deleteInsert, moveInsertBy, routeChannel } from '@app/actions/mixer';
import { useDoc, useServices, useSession } from '../../services-context';
import { useGestureEdit } from '../../edit';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { Fader } from './Fader';
import { FxRack } from './FxRack';
import { MeterBank } from './meters';
import styles from './Mixer.module.css';

const PAN = p.float(-1, 1, 0, { label: 'Pan' });

/** Names of the channels that play through an insert. */
function routedChannels(project: Project, id: InsertId): string {
  const names: string[] = [];
  for (const cid of project.channelOrder) {
    const ch = project.channels[cid];
    if (ch && ch.kind !== 'automation' && ch.output === id) names.push(ch.name);
  }
  return names.join(', ');
}

interface StripProps {
  id: InsertId;
  index: number;
  last: boolean;
  selected: boolean;
  meters: MeterBank;
}

const Strip = memo(function Strip({ id, index, last, selected, meters }: StripProps) {
  const services = useServices();
  const insert = useDoc((pr) => pr.mixer.inserts[id]);
  const routed = useDoc((pr) => routedChannels(pr, id));
  const [renaming, setRenaming] = useState(false);
  const isMaster = id === MASTER;
  const label = isMaster ? 'Master' : `Insert ${index}`;
  const volume = useGestureEdit<number>(`${label} volume`, (d, v) => setInsertProp(d, id, 'volume', v), `insvol:${id}`);
  const pan = useGestureEdit<number>(`${label} pan`, (d, v) => setInsertProp(d, id, 'pan', v), `inspan:${id}`);
  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => (el ? meters.attach(id, el) : undefined),
    [meters, id],
  );
  if (!insert) return null;

  const toggleMute = () =>
    services.history.transact(`${insert.muted ? 'Unmute' : 'Mute'} ${label}`, (d) =>
      setInsertProp(d, id, 'muted', !insert.muted),
    );
  const solo = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isMaster) services.history.transact(`Solo ${label}`, (d) => toggleSoloInsert(d, id));
  };

  const menu = (e: ReactMouseEvent) => {
    e.preventDefault();
    services.session.getState().selectInsert(id);
    const project = services.doc.getState().project;
    const chId = services.session.getState().selectedChannelId;
    const ch = chId ? project.channels[chId] : undefined;
    const items: MenuEntry[] = [
      { label: 'Rename…', onSelect: () => setRenaming(true) },
      {
        kind: 'swatches',
        colors: PALETTE,
        ...(insert.color ? { selected: insert.color } : {}),
        onSelect: (c) => services.history.transact(`${label} color`, (d) => setInsertProp(d, id, 'color', c)),
      },
    ];
    if (insert.color)
      items.push({
        label: 'Clear color',
        onSelect: () => services.history.transact(`${label} color`, (d) => setInsertProp(d, id, 'color', undefined)),
      });
    items.push({ kind: 'separator' });
    if (ch && chId && ch.kind !== 'automation')
      items.push({
        label: `Route “${ch.name}” here`,
        disabled: ch.output === id,
        onSelect: () => routeChannel(services, chId, id),
      });
    if (!isMaster) {
      items.push(
        { label: 'Move left', disabled: index <= 1, onSelect: () => moveInsertBy(services, id, -1) },
        { label: 'Move right', disabled: last, onSelect: () => moveInsertBy(services, id, 1) },
      );
    }
    items.push({ label: 'Insert new track after', onSelect: () => addMixerInsert(services, index) });
    if (!isMaster)
      items.push({ kind: 'separator' }, { label: 'Delete', danger: true, onSelect: () => deleteInsert(services, id) });
    showContextMenu(e, items);
  };

  const finishRename = (value: string | null) => {
    setRenaming(false);
    const name = value?.trim();
    if (name && name !== insert.name)
      services.history.transact(`Rename ${label}`, (d) => setInsertProp(d, id, 'name', name));
  };

  return (
    <div
      className={`${styles.strip} ${isMaster ? styles.master : ''} ${selected ? styles.stripSelected : ''}`}
      style={insert.color ? { ['--ins-color' as string]: insert.color } : undefined}
      onPointerDown={() => services.session.getState().selectInsert(id)}
      onContextMenu={menu}
      data-hint={`${label}${insert.name !== label ? ` (${insert.name})` : ''}: ${routed ? `plays ${routed}` : 'no channels routed here'}. Right-click for options`}
    >
      <span className={styles.stripNumber}>{isMaster ? 'M' : index}</span>
      {renaming ? (
        <input
          className={styles.rename}
          autoFocus
          defaultValue={insert.name}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finishRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = insert.name;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div className={styles.stripName} onDoubleClick={() => setRenaming(true)} title={insert.name}>
          {insert.name}
        </div>
      )}
      <Knob spec={PAN} value={insert.pan} size={22} bipolar label={`${label} pan`} {...pan} />
      <button
        tabIndex={-1}
        className={`${styles.led} ${insert.muted ? '' : styles.ledOn} ${insert.solo ? styles.ledSolo : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={toggleMute}
        onContextMenu={solo}
        data-hint={`${label}: ${insert.muted ? 'muted' : 'on'}${insert.solo ? ', solo' : ''}. Click to mute${isMaster ? '' : ', right-click to solo'}`}
        aria-label={insert.muted ? `Unmute ${label}` : `Mute ${label}`}
        aria-pressed={!insert.muted}
      />
      <div className={styles.meterFader}>
        <canvas ref={canvasRef} className={styles.meter} aria-hidden="true" />
        <Fader value={insert.volume} label={`${label} volume`} {...volume} />
      </div>
      <span className={styles.stripDb}>{formatGain(insert.volume)}</span>
    </div>
  );
});

/** FL-style mixer: master + insert strips on the left, the selected insert's effect slots on the right. */
export function Mixer() {
  const services = useServices();
  const order = useDoc((pr) => pr.mixer.order);
  const selected = useSession((s) => s.selectedInsertId);
  const current = useDoc((pr) => (selected && pr.mixer.inserts[selected] ? selected : MASTER));
  const [meters] = useState(() => new MeterBank());
  useEffect(() => meters.start(services), [meters, services]);

  return (
    <div className={styles.mixer}>
      <div className={styles.strips} onContextMenu={(e) => e.preventDefault()}>
        {order.map((id, i) => (
          <Strip key={id} id={id} index={i} last={i === order.length - 1} selected={id === current} meters={meters} />
        ))}
        <button
          tabIndex={-1}
          className={styles.addInsert}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => addMixerInsert(services)}
          data-hint="Add a mixer insert"
          aria-label="Add a mixer insert"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <FxRack insertId={current} />
    </div>
  );
}
