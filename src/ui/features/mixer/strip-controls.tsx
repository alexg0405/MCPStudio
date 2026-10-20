/**
 * The small controls inside a mixer strip. Each one reads only the part of the project it shows, so dragging a fader
 * or knob re-renders that control and its readout and not the strip around it (its name, buttons, routing and menus).
 */
import { memo } from 'react';
import { targetKey } from '@core/model/targets';
import { formatGain } from '@core/model/fader';
import { ROUTE_LEVEL_SPEC } from '@core/model/target-specs';
import { MASTER, type InsertId } from '@core/model/types';
import { setRouteLevel } from '@core/ops/routing';
import { canRoute } from '@core/query/routing';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { toggleRoute } from '@app/actions/mixer';
import { Icon } from '../../controls/Icon';
import { useGestureEdit } from '../../edit';
import { useDoc, useServices, useSession } from '../../services-context';
import { Fader } from './Fader';
import { useLinkedInsertEdit } from './linked-edit';
import { insertName, LOOP_HINT } from './routing';
import styles from './Mixer.module.css';

const PAN = p.float(-1, 1, 0, { label: 'Pan' });

/** "Centre", "40% left", "100% right". */
function panText(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  return percent === 0 ? 'Centre' : `${percent}% ${pan < 0 ? 'left' : 'right'}`;
}

const formatPan = (value: unknown) => panText(Number(value));
const formatSend = (value: unknown) => formatGain(Number(value));

/** The pan knob of a strip. */
export const StripPan = memo(function StripPan({ id, label, name }: { id: InsertId; label: string; name: string }) {
  const value = useDoc((project) => project.mixer.inserts[id]?.pan ?? 0);
  // A grouped track's pan moves its group mates too (when the group links pans).
  const pan = useLinkedInsertEdit(`${label} pan`, id, 'pan', `inspan:${id}`);
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

/** The volume fader of a strip. */
export const StripFader = memo(function StripFader({ id, label, name }: { id: InsertId; label: string; name: string }) {
  const value = useDoc((project) => project.mixer.inserts[id]?.volume ?? 1);
  // A grouped track's fader moves its group mates too (when the group links faders).
  const volume = useLinkedInsertEdit(`${label} volume`, id, 'volume', `insvol:${id}`);
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
export const StripDb = memo(function StripDb({ id }: { id: InsertId }) {
  const volume = useDoc((project) => project.mixer.inserts[id]?.volume ?? 1);
  return <span className={styles.stripDb}>{formatGain(volume)}</span>;
});

/** The selected insert (the Master when none is, or the selected one was deleted). */
export function useCurrentInsert(): InsertId {
  const selected = useSession((session) => session.selectedInsertId);
  const exists = useDoc((project) => !!selected && !!project.mixer.inserts[selected]);
  return selected && exists ? selected : MASTER;
}

/**
 * "IN" and "SC" next to the strip number: this track feeds the selected one, or the selected one's effect listens to
 * it. They follow the selection, so they are apart from the strip: picking another track re-renders these small
 * pieces on every strip and not the strips themselves.
 */
export const StripBadges = memo(function StripBadges({ id, name }: { id: InsertId; name: string }) {
  const current = useCurrentInsert();
  const currentName = useDoc((project) => insertName(project, current));
  const feedsCurrent = useDoc(
    (project) => current !== id && !!project.mixer.inserts[id]?.routes.some((route) => route.to === current),
  );
  const keysCurrent = useDoc(
    (project) => current !== id && !!project.mixer.inserts[current]?.fx.some((slot) => slot.sidechain === id),
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

/** What the send arrow's tooltip says: the send that exists, or what a click would do (or why it can't). */
function sendArrowHint(options: {
  send: { level: number; pre: boolean } | undefined;
  current: InsertId;
  currentName: string;
  name: string;
  isRoutable: boolean;
}): string {
  const { send, current, currentName, name, isRoutable } = options;
  if (send) {
    const preNote = send.pre ? ' (before its fader)' : '';
    return `“${currentName}” sends to “${name}” at ${formatGain(send.level)}${preNote}. Click to stop sending`;
  }
  if (current === MASTER) return 'Select a track first: this arrow sends the selected track here';
  return isRoutable ? `Click to send “${currentName}” to “${name}” as well` : LOOP_HINT;
}

/** The send arrow and send knob under a strip, relative to the selected insert (FL: on every other track). */
export const StripRoute = memo(function StripRoute({ id, name }: { id: InsertId; name: string }) {
  const services = useServices();
  const current = useCurrentInsert();
  const isSelected = id === current;
  const currentName = useDoc((project) => insertName(project, current));
  const send = useDoc((project) =>
    isSelected ? undefined : project.mixer.inserts[current]?.routes.find((route) => route.to === id),
  );
  const isRoutable = useDoc((project) => !isSelected && canRoute(project.mixer, current, id));
  const sendLevel = useGestureEdit<number>(
    `Send ${currentName} to ${name}`,
    (draft, level) => setRouteLevel(draft, current, id, level),
    `route:${current}:${id}`,
  );
  if (isSelected) return <span className={styles.routeRow} />;
  return (
    <div className={styles.routeRow}>
      {send ? (
        // Editing a send keeps the selection (and so the knob) where it is.
        <span className={styles.sendKnob} onPointerDown={(event) => event.stopPropagation()}>
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
        className={`${styles.routeArrow} ${send ? styles.routeOn : ''} ${send?.pre ? styles.routePre : ''}`}
        disabled={!send && !isRoutable}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={() => toggleRoute(services, current, id)}
        data-hint={sendArrowHint({ send, current, currentName, name, isRoutable })}
        aria-label={send ? `Stop sending ${currentName} to ${name}` : `Send ${currentName} to ${name}`}
        aria-pressed={!!send}
      >
        <Icon name="routeUp" size={12} />
      </button>
    </div>
  );
});
