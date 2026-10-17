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

const formatPan = (v: unknown) => panText(Number(v));
const formatSend = (v: unknown) => formatGain(Number(v));

/** "Centre", "40% left", "100% right". */
function panText(v: number): string {
  const pct = Math.round(Math.abs(v) * 100);
  return pct === 0 ? 'Centre' : `${pct}% ${v < 0 ? 'left' : 'right'}`;
}

/**
 * The three controls that change while a fader or knob is dragged. Each reads its own value, so a drag re-renders the
 * control and its readout and not the strip around them (its name, buttons, routing and menus), which reads
 * everything else.
 */
const StripPan = memo(function StripPan({ id, label, name }: { id: InsertId; label: string; name: string }) {
  const value = useDoc((pr) => pr.mixer.inserts[id]?.pan ?? 0);
  const pan = useGestureEdit<number>(`${label} pan`, (d, v) => setInsertProp(d, id, 'pan', v), `inspan:${id}`);
  return (
    <Knob
      spec={PAN}
      value={value}
      size={22}
      bipolar
      label={`${name} pan`}
      format={formatPan}
      param={targetKey({ kind: 'insert', insertId: id, param: 'pan' })}
      {...pan}
    />
  );
});

const StripFader = memo(function StripFader({ id, label, name }: { id: InsertId; label: string; name: string }) {
  const value = useDoc((pr) => pr.mixer.inserts[id]?.volume ?? 1);
  const volume = useGestureEdit<number>(`${label} volume`, (d, v) => setInsertProp(d, id, 'volume', v), `insvol:${id}`);
  return (
    <Fader
      value={value}
      label={`${name} volume`}
      param={targetKey({ kind: 'insert', insertId: id, param: 'volume' })}
      {...volume}
    />
  );
});

/** The fader's value in dB under it. */
const StripDb = memo(function StripDb({ id }: { id: InsertId }) {
  const volume = useDoc((pr) => pr.mixer.inserts[id]?.volume ?? 1);
  return <span className={styles.stripDb}>{formatGain(volume)}</span>;
});

/** The selected insert (the Master when none is, or the selected one was deleted). */
function useCurrentInsert(): InsertId {
  const selected = useSession((s) => s.selectedInsertId);
  const exists = useDoc((pr) => !!selected && !!pr.mixer.inserts[selected]);
  return selected && exists ? selected : MASTER;
}

/**
 * "IN" and "SC" next to the strip number: this track feeds the selected one, or the selected one's effect listens to
 * it. They follow the selection, so they are apart from the strip: picking another track re-renders these small
 * pieces on every strip and not the strips themselves.
 */
const StripBadges = memo(function StripBadges({ id, name }: { id: InsertId; name: string }) {
  const current = useCurrentInsert();
  const currentName = useDoc((pr) => insertName(pr, current));
  const feedsCurrent = useDoc((pr) => current !== id && !!pr.mixer.inserts[id]?.routes.some((r) => r.to === current));
  const keysCurrent = useDoc(
    (pr) => current !== id && !!pr.mixer.inserts[current]?.fx.some((s) => s.sidechain === id),
  );
  return (
    <>
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
    </>
  );
});

/** The send arrow and send knob under a strip, relative to the selected insert (FL: on every other track). */
const StripRoute = memo(function StripRoute({ id, name }: { id: InsertId; name: string }) {
  const services = useServices();
  const current = useCurrentInsert();
  const selected = id === current;
  const currentName = useDoc((pr) => insertName(pr, current));
  const send = useDoc((pr) => (selected ? undefined : pr.mixer.inserts[current]?.routes.find((r) => r.to === id)));
  const routable = useDoc((pr) => !selected && canRoute(pr.mixer, current, id));
  const sendLevel = useGestureEdit<number>(
    `Send ${currentName} to ${name}`,
    (d, v) => setRouteLevel(d, current, id, v),
    `route:${current}:${id}`,
  );
  if (selected) return <span className={styles.routeRow} />;
  const sendHint = send
    ? `“${currentName}” sends to “${name}” at ${formatGain(send.level)}${send.pre ? ' (before its fader)' : ''}. Click to stop sending`
    : current === MASTER
      ? 'Select a track first: this arrow sends the selected track here'
      : routable
        ? `Click to send “${currentName}” to “${name}” as well`
        : LOOP_HINT;
  return (
    <div className={styles.routeRow}>
      {send ? (
        // Editing a send keeps the selection (and so the knob) where it is.
        <span className={styles.sendKnob} onPointerDown={(e) => e.stopPropagation()}>
          <Knob
            spec={ROUTE_LEVEL_SPEC}
            value={send.level}
            size={18}
            label={`Send to ${name}`}
            format={formatSend}
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
  );
});

interface StripProps {
  id: InsertId;
  index: number;
  last: boolean;
  /** This strip is the selected insert. (Everything that is relative to the selection reads it itself: see StripRoute.) */
  selected: boolean;
  meters: MeterBank;
}

const Strip = memo(function Strip({ id, index, last, selected, meters }: StripProps) {
  const services = useServices();
  // The fields the strip itself shows. Volume and pan are left to StripFader/StripPan (see above).
  const exists = useDoc((pr) => !!pr.mixer.inserts[id]);
  const ownName = useDoc((pr) => pr.mixer.inserts[id]?.name ?? '');
  const color = useDoc((pr) => pr.mixer.inserts[id]?.color);
  const muted = useDoc((pr) => !!pr.mixer.inserts[id]?.muted);
  const soloed = useDoc((pr) => !!pr.mixer.inserts[id]?.solo);
  const routed = useDoc((pr) => routedChannels(pr, id));
  const [renaming, setRenaming] = useState(false);
  const isMaster = id === MASTER;
  const label = isMaster ? 'Master' : `Insert ${index}`;
  const name = useDoc((pr) => insertName(pr, id));
  const goesTo = useDoc((pr) => routeLine(pr, id));
  const routesText = useDoc((pr) => describeRoutes(pr, id));
  const silenced = useDoc((pr) => {
    const ins = pr.mixer.inserts[id];
    return !!ins && !ins.muted && effectivelyMutedInserts(pr.mixer.inserts).has(id);
  });
  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => (el ? meters.attach(id, el) : undefined),
    [meters, id],
  );
  if (!exists) return null;

  const toggleMute = () =>
    services.history.transact(`${muted ? 'Unmute' : 'Mute'} ${label}`, (d) => setInsertProp(d, id, 'muted', !muted));
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
        ...(color ? { selected: color } : {}),
        onSelect: (c) => services.history.transact(`${label} color`, (d) => setInsertProp(d, id, 'color', c)),
      },
    ];
    if (color)
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
    if (next && next !== ownName)
      services.history.transact(`Rename ${label}`, (d) => setInsertProp(d, id, 'name', next));
  };

  const stripHint =
    `${name}${name !== label ? ` (${label})` : ''}: ${routed ? `plays ${routed}` : 'no channels play here'}` +
    (isMaster ? '; everything ends up here' : `; goes to ${routesText}`) +
    (silenced ? '. Silent while another track is soloed' : '') +
    '. Click to select it (its effects show on the right), right-click for routing';

  return (
    <div
      className={`${styles.strip} ${isMaster ? styles.master : ''} ${selected ? styles.stripSelected : ''} ${silenced ? styles.stripSilenced : ''}`}
      style={color ? { ['--ins-color' as string]: color } : undefined}
      onPointerDown={(e) => {
        if (e.button === 0) services.session.getState().selectInsert(id);
      }}
      onContextMenu={menu}
      data-hint={stripHint}
    >
      <span className={styles.stripNumber}>
        {isMaster ? 'M' : index}
        <StripBadges id={id} name={name} />
      </span>
      {renaming ? (
        <input
          className={styles.rename}
          autoFocus
          defaultValue={ownName}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finishRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = ownName;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div
          className={styles.stripName}
          onDoubleClick={() => setRenaming(true)}
          title={ownName}
          data-hint={`${name}. Double-click to rename`}
        >
          {ownName}
        </div>
      )}
      <StripPan id={id} label={label} name={name} />
      <button
        tabIndex={-1}
        className={`${styles.led} ${muted ? '' : styles.ledOn} ${soloed ? styles.ledSolo : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={toggleMute}
        onContextMenu={solo}
        data-hint={`${name}: ${muted ? 'muted' : 'on'}${soloed ? ', soloed' : ''}. Click to mute${isMaster ? '' : '; right-click to solo (hear only this track, what feeds it and where it goes)'}`}
        aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
        aria-pressed={!muted}
      />
      <div className={styles.meterFader}>
        <canvas ref={canvasRef} className={styles.meter} aria-hidden="true" />
        <StripFader id={id} label={label} name={name} />
      </div>
      <StripDb id={id} />
      <span
        className={`${styles.routeLine} ${selected ? styles.routeLineSelected : ''}`}
        data-hint={isMaster ? 'The Master plays everything to your speakers' : `${name} goes to ${routesText}`}
      >
        {goesTo}
      </span>
      <StripRoute id={id} name={name} />
    </div>
  );
});

/** FL-style mixer: master + insert strips on the left, the selected insert's effect slots on the right. */
export function Mixer() {
  const services = useServices();
  const order = useDoc((pr) => pr.mixer.order);
  const current = useCurrentInsert();
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
