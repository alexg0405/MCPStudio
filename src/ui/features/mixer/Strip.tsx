import { memo, useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { setMutedLinked, toggleSoloLinked } from '@core/ops/linked-edits';
import { setInsertProp } from '@core/ops/mixer';
import { effectivelyMutedInserts } from '@core/query/mixer';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices, useSession } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { GroupBand } from './GroupBand';
import { MasterLoudness } from './MasterLoudness';
import type { MeterBank } from './meters';
import { RenameInput } from './RenameInput';
import { describeRoutes, insertName, routeLine } from './routing';
import { stripMenuEntries } from './strip-menu';
import { StripBadges, StripDb, StripFader, StripPan, StripRoute } from './strip-controls';
import styles from './Mixer.module.css';

/** Names of the channels that play through an insert. */
function routedChannels(project: Project, id: InsertId): string {
  const names: string[] = [];
  for (const channelId of project.channelOrder) {
    const channel = project.channels[channelId];
    if (channel && channel.kind !== 'automation' && channel.output === id) names.push(channel.name);
  }
  return names.join(', ');
}

/** The strip's tooltip: what it is, what plays through it, where it goes and how to use it. */
function stripHint(strip: {
  name: string;
  label: string;
  routed: string;
  routesText: string;
  isMaster: boolean;
  isSilenced: boolean;
}): string {
  const { name, label, routed, routesText, isMaster, isSilenced } = strip;
  const nameNote = name !== label ? ` (${label})` : '';
  const playsNote = routed ? `plays ${routed}` : 'no channels play here';
  const goesNote = isMaster ? '; everything ends up here' : `; goes to ${routesText}`;
  const silentNote = isSilenced ? '. Silent while another track is soloed' : '';
  return `${name}${nameNote}: ${playsNote}${goesNote}${silentNote}. Click to select it (its effects show on the right), right-click for routing`;
}

/** What a strip needs from the mixer: which insert, where it stands, whether it is selected, and the meters. */
export interface StripProps {
  id: InsertId;
  /** 0 for the Master, 1… for the tracks. */
  index: number;
  isLast: boolean;
  /** This strip is the selected insert. (Everything that is relative to the selection reads it itself: see StripRoute.) */
  isSelected: boolean;
  meters: MeterBank;
}

/** One mixer strip: number, name, pan, mute, meter and fader, level readout and routing. */
export const Strip = memo(function Strip({ id, index, isLast, isSelected, meters }: StripProps) {
  const services = useServices();
  // The fields the strip itself shows. Volume and pan are left to StripFader/StripPan (see strip-controls).
  const exists = useDoc((project) => !!project.mixer.inserts[id]);
  const ownName = useDoc((project) => project.mixer.inserts[id]?.name ?? '');
  const color = useDoc((project) => project.mixer.inserts[id]?.color);
  const isMuted = useDoc((project) => !!project.mixer.inserts[id]?.muted);
  const isSoloed = useDoc((project) => !!project.mixer.inserts[id]?.solo);
  const isSoloSafe = useDoc((project) => !!project.mixer.inserts[id]?.soloSafe);
  const isMarked = useSession((session) => session.markedInsertIds.includes(id));
  const routed = useDoc((project) => routedChannels(project, id));
  const [isRenaming, setIsRenaming] = useState(false);
  const isMaster = id === MASTER;
  const label = isMaster ? 'Master' : `Insert ${index}`;
  const name = useDoc((project) => insertName(project, id));
  const goesTo = useDoc((project) => routeLine(project, id));
  const routesText = useDoc((project) => describeRoutes(project, id));
  const isSilenced = useDoc((project) => {
    const insert = project.mixer.inserts[id];
    return !!insert && !insert.muted && effectivelyMutedInserts(project.mixer.inserts).has(id);
  });
  const meterCanvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => (canvas ? meters.attach(id, canvas) : undefined),
    [meters, id],
  );
  if (!exists) return null;

  const toggleMute = () =>
    services.history.transact(`${isMuted ? 'Unmute' : 'Mute'} ${label}`, (draft) =>
      setMutedLinked(draft, id, !isMuted),
    );
  const toggleSolo = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isMaster) services.history.transact(`Solo ${label}`, (draft) => toggleSoloLinked(draft, id));
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startRename = () => setIsRenaming(true);
    showContextMenu(event, stripMenuEntries({ services, id, index, label, name, color, isLast, startRename }));
  };
  const finishRename = (value: string) => {
    setIsRenaming(false);
    const newName = value.trim();
    if (newName && newName !== ownName) {
      services.history.transact(`Rename ${label}`, (draft) => setInsertProp(draft, id, 'name', newName));
    }
  };

  const classNames = [
    styles.strip,
    isMaster && styles.master,
    isSelected && styles.stripSelected,
    isMarked && styles.stripMarked,
    isSilenced && styles.stripSilenced,
  ];
  return (
    <div
      className={classNames.filter(Boolean).join(' ')}
      style={color ? { ['--ins-color' as string]: color } : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Shift or Ctrl on the strip's own area picks several tracks (for Group and Link); on a control it keeps its own meaning.
        const isOnControl = event.target instanceof Element && !!event.target.closest('button, input, canvas, [role]');
        const isPicking = (event.shiftKey || event.ctrlKey || event.metaKey) && !isOnControl;
        if (isPicking) services.session.getState().toggleMarkedInsert(id);
        // Working a control of a picked strip keeps the picks (a plain click on the strip clears them).
        else if (!(isMarked && isOnControl)) services.session.getState().selectInsert(id);
      }}
      onContextMenu={openMenu}
      data-hint={stripHint({ name, label, routed, routesText, isMaster, isSilenced })}
    >
      <GroupBand id={id} />
      <span className={styles.stripNumber}>
        {isMaster ? 'M' : index}
        <StripBadges id={id} name={name} />
        {isSoloSafe && (
          <span className={styles.soloSafeBadge} data-hint={`${name} is solo-safe: a solo elsewhere does not silence it`}>
            SAFE
          </span>
        )}
      </span>
      {isRenaming ? (
        <RenameInput initialName={ownName} onDone={finishRename} />
      ) : (
        <div
          className={styles.stripName}
          onDoubleClick={() => setIsRenaming(true)}
          title={ownName}
          data-hint={`${name}. Double-click to rename`}
        >
          {ownName}
        </div>
      )}
      <StripPan id={id} label={label} name={name} />
      <button
        className={`${styles.led} ${isMuted ? '' : styles.ledOn} ${isSoloed ? styles.ledSolo : ''}`}
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleMute}
        onContextMenu={toggleSolo}
        data-hint={`${name}: ${isMuted ? 'muted' : 'on'}${isSoloed ? ', soloed' : ''}. Click to mute${isMaster ? '' : '; right-click to solo (hear only this track, what feeds it and where it goes)'}`}
        aria-label={isMuted ? `Unmute ${label}` : `Mute ${label}`}
        aria-pressed={!isMuted}
      />
      <div className={styles.meterFader}>
        <canvas
          ref={meterCanvasRef}
          className={styles.meter}
          aria-hidden="true"
          {...(isMaster
            ? {
                onClick: () => openWindow(services, 'meters'),
                'data-hint':
                  'The master level. Click it to open the Meters window (loudness, true peak, stereo, spectrum)',
              }
            : {})}
        />
        <StripFader id={id} label={label} name={name} />
      </div>
      <StripDb id={id} />
      {isMaster && <MasterLoudness />}
      <span
        className={`${styles.routeLine} ${isSelected ? styles.routeLineSelected : ''}`}
        data-hint={isMaster ? 'The Master plays everything to your speakers' : `${name} goes to ${routesText}`}
      >
        {goesTo}
      </span>
      <StripRoute id={id} name={name} />
    </div>
  );
});
