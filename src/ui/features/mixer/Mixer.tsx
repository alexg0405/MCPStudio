import { targetKey } from '@core/model/targets';
import { memo, useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PALETTE } from '@core/model/defaults';
import { formatGain } from '@core/model/fader';
import { ROUTE_LEVEL_SPEC } from '@core/model/target-specs';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { setInsertProp, toggleSoloInsert } from '@core/ops/mixer';
import { setRouteLevel } from '@core/ops/routing';
import { effectivelyMutedInserts } from '@core/query/mixer';
import { canRoute } from '@core/query/routing';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { addMixerInsert, deleteInsert, moveInsertBy, routeChannel, toggleRoute } from '@app/actions/mixer';
import { useDoc, useServices, useSession } from '../../services-context';
import { useGestureEdit } from '../../edit';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { Icon } from '../../controls/Icon';
import { Fader } from './Fader';
import { FxRack } from './FxRack';
import { MeterBank } from './meters';
import { describeRoutes, insertName, LOOP_HINT, routeLine } from './routing';
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

/** "Centre", "40% left", "100% right". */
function panText(v: number): string {
  const pct = Math.round(Math.abs(v) * 100);
  return pct === 0 ? 'Centre' : `${pct}% ${v < 0 ? 'left' : 'right'}`;
}

interface StripProps {
  id: InsertId;
  index: number;
  last: boolean;
  /** The selected insert: the send arrow and knob on every other strip are relative to it. */
  current: InsertId;
  meters: MeterBank;
}

const Strip = memo(function Strip({ id, index, last, current, meters }: StripProps) {
  const services = useServices();
  const insert = useDoc((pr) => pr.mixer.inserts[id]);
  const routed = useDoc((pr) => routedChannels(pr, id));
  const [renaming, setRenaming] = useState(false);
  const isMaster = id === MASTER;
  const selected = id === current;
  const label = isMaster ? 'Master' : `Insert ${index}`;
  const name = useDoc((pr) => insertName(pr, id));
  const currentName = useDoc((pr) => insertName(pr, current));
  const goesTo = useDoc((pr) => routeLine(pr, id));
  const routesText = useDoc((pr) => describeRoutes(pr, id));
  // Routing relative to the selected insert (FL: an arrow and a send knob on every other track).
  const send = useDoc((pr) => (selected ? undefined : pr.mixer.inserts[current]?.routes.find((r) => r.to === id)));
  const routable = useDoc((pr) => !selected && canRoute(pr.mixer, current, id));
  const feedsCurrent = useDoc((pr) => !selected && !!pr.mixer.inserts[id]?.routes.some((r) => r.to === current));
  const keysCurrent = useDoc((pr) => !selected && !!pr.mixer.inserts[current]?.fx.some((s) => s.sidechain === id));
  const silenced = useDoc((pr) => {
    const ins = pr.mixer.inserts[id];
    return !!ins && !ins.muted && effectivelyMutedInserts(pr.mixer.inserts).has(id);
  });
  const sendLevel = useGestureEdit<number>(
    `Send ${currentName} to ${name}`,
    (d, v) => setRouteLevel(d, current, id, v),
    `route:${current}:${id}`,
  );
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
    // The selection stays: the menu routes the selected insert to this one (FL: select the source,
    // right-click the destination). Everything else in it acts on this strip.
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
        hint:
          ch.output === id ? `“${ch.name}” already plays through ${name}` : `Play channel “${ch.name}” through ${name}`,
        onSelect: () => routeChannel(services, chId, id),
      });
    if (!isMaster) {
      items.push(
        { label: 'Move left', disabled: index <= 1, onSelect: () => moveInsertBy(services, id, -1) },
        { label: 'Move right', disabled: last, onSelect: () => moveInsertBy(services, id, 1) },
      );
    }
    items.push({ label: 'Insert new track after', onSelect: () => addMixerInsert(services, index) });
    items.push(...extraMenuItems('mixer.strip', { insertId: id }, services));
    if (!isMaster)
      items.push({ kind: 'separator' }, { label: 'Delete', danger: true, onSelect: () => deleteInsert(services, id) });
    showContextMenu(e, items);
  };

  const finishRename = (value: string | null) => {
    setRenaming(false);
    const next = value?.trim();
    if (next && next !== insert.name)
      services.history.transact(`Rename ${label}`, (d) => setInsertProp(d, id, 'name', next));
  };

  const sendHint = send
    ? `“${currentName}” sends to “${name}” at ${formatGain(send.level)}${send.pre ? ' (before its fader)' : ''}. Click to stop sending`
    : current === MASTER
      ? 'Select a track first: this arrow sends the selected track here'
      : routable
        ? `Click to send “${currentName}” to “${name}” as well`
        : LOOP_HINT;
  const stripHint =
    `${name}${name !== label ? ` (${label})` : ''}: ${routed ? `plays ${routed}` : 'no channels play here'}` +
    (isMaster ? '; everything ends up here' : `; goes to ${routesText}`) +
    (silenced ? '. Silent while another track is soloed' : '') +
    '. Click to select it (its effects show on the right), right-click for routing';

  return (
    <div
      className={`${styles.strip} ${isMaster ? styles.master : ''} ${selected ? styles.stripSelected : ''} ${silenced ? styles.stripSilenced : ''}`}
      style={insert.color ? { ['--ins-color' as string]: insert.color } : undefined}
      onPointerDown={(e) => {
        if (e.button === 0) services.session.getState().selectInsert(id);
      }}
      onContextMenu={menu}
      data-hint={stripHint}
    >
      <span className={styles.stripNumber}>
        {isMaster ? 'M' : index}
        {feedsCurrent && (
          <span className={styles.badgeIn} data-hint={`“${name}” is sent into the selected track “${currentName}”`}>
            IN
          </span>
        )}
        {keysCurrent && (
          <span
            className={styles.badgeSc}
            data-hint={`An effect on the selected track “${currentName}” reacts to “${name}” (sidechain)`}
          >
            SC
          </span>
        )}
      </span>
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
        <div
          className={styles.stripName}
          onDoubleClick={() => setRenaming(true)}
          title={insert.name}
          data-hint={`${name}. Double-click to rename`}
        >
          {insert.name}
        </div>
      )}
      <Knob
        spec={PAN}
        value={insert.pan}
        size={22}
        bipolar
        label={`${name} pan`}
        format={(v) => panText(Number(v))}
        param={targetKey({ kind: 'insert', insertId: id, param: 'pan' })}
        {...pan}
      />
      <button
        tabIndex={-1}
        className={`${styles.led} ${insert.muted ? '' : styles.ledOn} ${insert.solo ? styles.ledSolo : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={toggleMute}
        onContextMenu={solo}
        data-hint={`${name}: ${insert.muted ? 'muted' : 'on'}${insert.solo ? ', soloed' : ''}. Click to mute${isMaster ? '' : '; right-click to solo (hear only this track, what feeds it and where it goes)'}`}
        aria-label={insert.muted ? `Unmute ${label}` : `Mute ${label}`}
        aria-pressed={!insert.muted}
      />
      <div className={styles.meterFader}>
        <canvas ref={canvasRef} className={styles.meter} aria-hidden="true" />
        <Fader
          value={insert.volume}
          label={`${name} volume`}
          param={targetKey({ kind: 'insert', insertId: id, param: 'volume' })}
          {...volume}
        />
      </div>
      <span className={styles.stripDb}>{formatGain(insert.volume)}</span>
      <span
        className={`${styles.routeLine} ${selected ? styles.routeLineSelected : ''}`}
        data-hint={isMaster ? 'The Master plays everything to your speakers' : `${name} goes to ${routesText}`}
      >
        {goesTo}
      </span>
      {selected ? (
        <span className={styles.routeRow} />
      ) : (
        <div className={styles.routeRow}>
          {send ? (
            // Editing a send keeps the selection (and so the knob) where it is.
            <span className={styles.sendKnob} onPointerDown={(e) => e.stopPropagation()}>
              <Knob
                spec={ROUTE_LEVEL_SPEC}
                value={send.level}
                size={18}
                label={`Send to ${name}`}
                format={(v) => formatGain(Number(v))}
                param={targetKey({ kind: 'route', insertId: current, to: id })}
                {...sendLevel}
              />
            </span>
          ) : (
            <span className={styles.knobGap} />
          )}
          <button
            tabIndex={-1}
            className={`${styles.routeArrow} ${send ? styles.routeOn : ''} ${send?.pre ? styles.routePre : ''}`}
            disabled={!send && !routable}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => toggleRoute(services, current, id)}
            data-hint={sendHint}
            aria-label={send ? `Stop sending ${currentName} to ${name}` : `Send ${currentName} to ${name}`}
            aria-pressed={!!send}
          >
            <Icon name="routeUp" size={12} />
          </button>
        </div>
      )}
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
          <Strip key={id} id={id} index={i} last={i === order.length - 1} current={current} meters={meters} />
        ))}
        <button
          tabIndex={-1}
          className={styles.addInsert}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => addMixerInsert(services)}
          data-hint="Add a mixer track (insert)"
          aria-label="Add a mixer insert"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <FxRack insertId={current} />
    </div>
  );
}
