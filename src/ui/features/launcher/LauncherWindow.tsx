import { Fragment, memo, useEffect, useLayoutEffect, useRef, type DragEvent } from 'react';
import { useStore } from 'zustand';
import { fillFromClips, fillFromPatterns, putAudioFilesAt, putClipsAt, putInSlotAt } from '@app/launcher/edit';
import {
  DEFAULT_SCENES,
  DEFAULT_TRACKS,
  MODE_LABELS,
  QUANTIZE_LABELS,
  filledSlots,
  slotColor,
  slotLabel,
  slotLoops,
  slotMode,
} from '@core/launcher/grid';
import { LAUNCH_QUANTIZES, type LaunchQuantize, type LaunchSlot, type LaunchTrack, type LaunchTrackId, type PatternId, type SceneId } from '@core/model/types';
import { LAUNCH_PAD_SIZE, type LaunchPageDir } from '@core/midi-map/targets';
import { addLaunchTrack, addScene, moveSlot, setLauncherQuantize } from '@core/ops/launcher';
import { dragMayHaveAudio, takeAudioFiles } from '../../audio-drag';
import { CLIP_DROP_ATTR, CLIP_DROP_EVENT, type ClipDropDetail } from '../../clip-drop';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import styles from './Launcher.module.css';
import { sceneMenu, slotMenu, trackMenu } from './menus';
import { LauncherView } from './view-controller';

const PATTERN_DRAG = 'application/x-agstudio-pattern';
const SLOT_DRAG = 'application/x-agstudio-launch-slot';

export const EMPTY_TITLE = 'Nothing to launch yet';
export const EMPTY_TEXT =
  'Drag a pattern from the Browser, a clip from the playlist or an audio file from your computer into a slot, or right-click a slot to choose one. Then press a slot (or a scene) to start it in time with the song: patterns loop, one slot plays per track, and a new one replaces it on the next bar.';

/** The clip launcher: perform and jam with the project's patterns and audio clips. */
export function LauncherWindow() {
  const services = useServices();
  const session = services.launcher;
  const launcher = useDoc((p) => p.launcher);
  const recording = useStore(session.store, (s) => s.recording);
  const cursor = useStore(session.store, (s) => s.cursor);
  const page = useStore(session.store, (s) => s.page);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<LauncherView | null>(null);

  const trackIds = launcher?.trackOrder ?? [];
  const sceneIds = launcher?.sceneOrder ?? [];
  const nTracks = launcher ? trackIds.length : DEFAULT_TRACKS;
  const nScenes = launcher ? sceneIds.length : DEFAULT_SCENES;
  const empty = filledSlots(launcher).length === 0;
  // The pads (a controller) show one 8 × 8 page at a time: with a bigger grid the rest is dimmed, and arrows move the page.
  const pages = { tracks: Math.max(1, Math.ceil(nTracks / LAUNCH_PAD_SIZE)), scenes: Math.max(1, Math.ceil(nScenes / LAUNCH_PAD_SIZE)) };
  const paged = pages.tracks > 1 || pages.scenes > 1;
  const padPage = { track: Math.min(page.track, pages.tracks - 1), scene: Math.min(page.scene, pages.scenes - 1) };
  const trackOn = (ti: number) => !paged || Math.floor(ti / LAUNCH_PAD_SIZE) === padPage.track;
  const sceneOn = (si: number) => !paged || Math.floor(si / LAUNCH_PAD_SIZE) === padPage.scene;

  // The live play states are painted by a frame callback, not by React.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const view = new LauncherView(el, services);
    viewRef.current = view;
    view.refresh();
    view.start();
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [services]);
  useLayoutEffect(() => viewRef.current?.refresh());

  // Playlist clips dragged here with the pointer (the playlist hands the drag over, see ui/clip-drop.ts).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onClipDrop = (e: Event) => {
      const slot = (e.target as Element).closest<HTMLElement>('[data-slot]');
      if (!slot) return;
      const { clipIds } = (e as CustomEvent<ClipDropDetail>).detail;
      const r = putClipsAt(services, clipIds, Number(slot.dataset.ti), Number(slot.dataset.si));
      const toast = services.session.getState().toast;
      if (r.placed) toast(`Put ${r.placed} clip${r.placed === 1 ? '' : 's'} in the launcher${r.skipped ? ` (${r.skipped} could not go: automation clips can’t be launched)` : ''}. Undo takes them back.`);
      else toast('Nothing to put there: automation clips can’t be launched.', 'error');
    };
    el.addEventListener(CLIP_DROP_EVENT, onClipDrop);
    return () => el.removeEventListener(CLIP_DROP_EVENT, onClipDrop);
  }, [services]);

  // Moving the pads to another page shows it.
  useEffect(() => {
    if (!paged) return;
    rootRef.current
      ?.querySelector(`[data-ti="${padPage.track * LAUNCH_PAD_SIZE}"][data-si="${padPage.scene * LAUNCH_PAD_SIZE}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padPage.track, padPage.scene]);

  // Gate slots stop when the key is let go.
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') session.pressAt(cursor.track, cursor.scene, false);
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      tabIndex={0}
      role="group"
      aria-label="Clip launcher"
      onKeyUp={onKeyUp}
      data-tour="launcher"
      data-window-focus="launcher"
      data-hint="Clip launcher: arrow keys move the highlight, Enter launches the highlighted slot, number keys launch scenes, the period key stops its track"
    >
      <div className={styles.bar}>
        <span className={styles.label}>Launch on</span>
        <select
          className={styles.select}
          value={launcher?.quantize ?? 'bar'}
          onChange={(e) => services.history.transact('Launcher quantize', (d) => setLauncherQuantize(d, e.target.value as LaunchQuantize))}
          aria-label="Launch quantize"
          data-hint="When a press takes effect: right away, or on the next beat (1/4 note), bar (4 beats), 2 bars or 4 bars. A slot can have its own"
        >
          {LAUNCH_QUANTIZES.map((q) => (
            <option key={q} value={q}>
              {QUANTIZE_LABELS[q]}
            </option>
          ))}
        </select>
        <button className={styles.button} onClick={() => session.stopAll()} data-hint="Stop every track at the next boundary (right-click for an immediate stop)" onContextMenu={(e) => {
          e.preventDefault();
          session.stopAll(true);
        }}>
          <Icon name="stop" size={12} /> Stop all
        </button>
        <button
          className={recording ? styles.recording : styles.button}
          onClick={() => session.toggleRecording()}
          aria-pressed={recording}
          data-hint={
            recording
              ? 'Recording what you launch: press again to end at the next bar and write it to the playlist (one undo step)'
              : 'Record performance to playlist: from the next bar everything you launch is kept, and press again to put it on the playlist as clips'
          }
        >
          <Icon name="record" size={12} /> {recording ? 'Recording…' : 'Record performance'}
        </button>
        <span className={styles.spacer} />
        <button className={styles.button} onClick={() => services.history.transact('Add launcher scene', (d) => void addScene(d))} data-hint="Add a row (a scene) at the bottom of the grid">
          <Icon name="plus" size={12} /> Scene
        </button>
        <button className={styles.button} onClick={() => services.history.transact('Add launcher track', (d) => void addLaunchTrack(d))} data-hint="Add a column (a track): it plays one slot at a time">
          <Icon name="plus" size={12} /> Track
        </button>
        {paged && <PageButtons track={padPage.track} scene={padPage.scene} pages={pages} />}
        <button className={styles.button} onClick={() => void services.commands.run('dj.controllers.open')} data-hint="Connect a pad controller (Launchpad and similar) or link pads with MIDI learn">
          <Icon name="midi" size={12} /> Pads…
        </button>
      </div>

      <div className={styles.scroll}>
        <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${nTracks}, minmax(104px, 1fr)) minmax(120px, 150px)` }}>
          {Array.from({ length: nTracks }, (_, ti) => (
            <TrackHead key={trackIds[ti] ?? `t${ti}`} track={launcher?.tracks[trackIds[ti] as LaunchTrackId]} index={ti} off={!trackOn(ti)} />
          ))}
          <div className={styles.corner} data-hint="Scene buttons: launch a whole row of slots together">
            Scenes
          </div>
          {Array.from({ length: nScenes }, (_, si) => {
            const sceneId = sceneIds[si];
            return (
              <Fragment key={sceneId ?? `s${si}`}>
                {Array.from({ length: nTracks }, (_, ti) => {
                  const trackId = trackIds[ti];
                  const slot = trackId && sceneId ? launcher?.tracks[trackId]?.slots[sceneId] : undefined;
                  return (
                    <Slot
                      key={trackId ?? `t${ti}`}
                      ti={ti}
                      si={si}
                      trackId={trackId}
                      sceneId={sceneId}
                      slot={slot}
                      track={trackId ? launcher?.tracks[trackId] : undefined}
                      cursor={cursor.track === ti && cursor.scene === si}
                      off={!trackOn(ti) || !sceneOn(si)}
                    />
                  );
                })}
                <SceneButton sceneId={sceneId} index={si} name={sceneId ? launcher?.scenes[sceneId]?.name : undefined} off={!sceneOn(si)} />
              </Fragment>
            );
          })}
          {Array.from({ length: nTracks }, (_, ti) => (
            <StopButton key={trackIds[ti] ?? `t${ti}`} trackId={trackIds[ti]} index={ti} off={!trackOn(ti)} />
          ))}
          <div />
        </div>
      </div>

      {empty && (
        <div className={styles.empty} role="status">
          <div className={styles.emptyTitle}>{EMPTY_TITLE}</div>
          <div className={styles.emptyText}>{EMPTY_TEXT}</div>
          <div className={styles.emptyActions}>
            <button
              className={styles.button}
              onClick={() => {
                const n = fillFromPatterns(services);
                services.session.getState().toast(`Put ${n} pattern${n === 1 ? '' : 's'} in the first track, one per scene.`);
              }}
              data-hint="Fill the first track with your patterns, one in each scene, ready to launch"
            >
              Put my patterns in the grid
            </button>
            <button
              className={styles.button}
              onClick={() => {
                const sel = services.editor.getState().clipSelection;
                const r = fillFromClips(services, sel);
                services.session.getState().toast(
                  r.placed ? `Sent ${r.placed} clip${r.placed === 1 ? '' : 's'} to the launcher.` : 'Select clips in the playlist first (patterns or audio).',
                  r.placed ? 'info' : 'error',
                );
              }}
              data-hint="Put the clips selected in the playlist into free slots (a playlist track becomes a launcher track)"
            >
              Send selected playlist clips
            </button>
          </div>
        </div>
      )}
      <Status />
    </div>
  );
}

/** One line under the grid: what the cursor is on, or how to use the grid. */
function Status() {
  const services = useServices();
  const cursor = useStore(services.launcher.store, (s) => s.cursor);
  const text = useDoc((p) => {
    const l = p.launcher;
    const slot = l ? l.tracks[l.trackOrder[cursor.track] as LaunchTrackId]?.slots[l.sceneOrder[cursor.scene] as SceneId] : undefined;
    if (!slot) return `Track ${cursor.track + 1}, scene ${cursor.scene + 1}: empty. Arrow keys move, Enter launches, number keys launch scenes.`;
    return `Track ${cursor.track + 1}, scene ${cursor.scene + 1}: ${slotLabel(p, slot)} · ${MODE_LABELS[slotMode(slot)]}${slotLoops(slot) ? ', loops' : ', plays once'}`;
  });
  return <div className={styles.status}>{text}</div>;
}

/** The pad page: arrows move the 8 × 8 page the controller pads show (only when the grid is bigger than one page). */
function PageButtons({ track, scene, pages }: { track: number; scene: number; pages: { tracks: number; scenes: number } }) {
  const services = useServices();
  const arrow = (dir: LaunchPageDir, glyph: string, can: boolean, word: string) => (
    <button
      className={styles.pageButton}
      onClick={() => services.launcher.movePage(dir)}
      disabled={!can}
      aria-label={`Pad page ${dir}`}
      data-hint={`Move the controller pads one page ${dir}: ${word} (the dimmed slots are off the pads’ page)`}
    >
      {glyph}
    </button>
  );
  return (
    <span className={styles.pageGroup} role="group" aria-label="Pad page" data-hint="Which 8 × 8 part of the grid the controller pads press and light (the Launchpad arrow buttons move it)">
      <span className={styles.label}>
        Pads {track + 1},{scene + 1} of {pages.tracks}×{pages.scenes}
      </span>
      {arrow('left', '◂', track > 0, 'tracks before these')}
      {arrow('up', '▴', scene > 0, 'scenes above these')}
      {arrow('down', '▾', scene < pages.scenes - 1, 'scenes below these')}
      {arrow('right', '▸', track < pages.tracks - 1, 'tracks after these')}
    </span>
  );
}

const TrackHead = memo(function TrackHead({ track, index, off }: { track: LaunchTrack | undefined; index: number; off: boolean }) {
  const services = useServices();
  const laneName = useDoc((p) => (track?.laneId ? p.playlist.lanes[track.laneId]?.name : undefined));
  return (
    <div
      className={styles.head}
      data-off-page={off ? '' : undefined}
      style={track?.color ? ({ ['--c' as string]: track.color } as React.CSSProperties) : undefined}
      onContextMenu={(e) => {
        if (!track) return;
        e.preventDefault();
        trackMenu(services, e, track.id, index);
      }}
      data-hint={`${track?.name ?? `Track ${index + 1}`}: plays one slot at a time. Right-click to rename, colour it or let it take over a playlist track`}
    >
      <span className={styles.headName}>{track?.name ?? `Track ${index + 1}`}</span>
      {laneName && (
        <span className={styles.lane} title={`Takes over ${laneName} in the playlist while it plays`}>
          ⇄ {laneName}
        </span>
      )}
    </div>
  );
});

interface SlotProps {
  ti: number;
  si: number;
  trackId: LaunchTrackId | undefined;
  sceneId: SceneId | undefined;
  slot: LaunchSlot | undefined;
  track: LaunchTrack | undefined;
  cursor: boolean;
  /** Not on the page the controller pads show. */
  off: boolean;
}

const Slot = memo(function Slot({ ti, si, trackId, sceneId, slot, track, cursor, off }: SlotProps) {
  const services = useServices();
  const session = services.launcher;
  const label = useDoc((p) => (slot ? slotLabel(p, slot) : ''));
  const color = useDoc((p) => (slot ? slotColor(p, slot, track) : ''));
  const mode = slot ? slotMode(slot) : 'trigger';
  const meta = slot ? [mode === 'trigger' ? '' : MODE_LABELS[mode].toLowerCase(), slotLoops(slot) ? '' : '1×', slot.follow ? '↦' : ''].filter(Boolean).join(' ') : '';
  const ref = useRef<HTMLDivElement>(null);

  const onDrop = (e: DragEvent) => {
    ref.current?.classList.remove(styles.drop as string);
    const dt = e.dataTransfer;
    const pattern = dt.getData(PATTERN_DRAG);
    const moved = dt.getData(SLOT_DRAG);
    if (!pattern && !moved) {
      // Audio files (from the computer, or out of the sample browser): read now, the drop's data is gone afterwards.
      const files = takeAudioFiles(dt);
      if (!files) return;
      e.preventDefault();
      void putAudioFilesAt(services, files, ti, si).then((n) => {
        if (n) services.session.getState().toast(`Put ${n} audio file${n === 1 ? '' : 's'} in the launcher. Undo takes ${n === 1 ? 'it' : 'them'} back.`);
      });
      return;
    }
    e.preventDefault();
    if (pattern) {
      const problem = putInSlotAt(services, ti, si, { kind: 'pattern', patternId: pattern as PatternId });
      if (problem) services.session.getState().toast(problem, 'error');
      return;
    }
    try {
      const from = JSON.parse(moved) as { t: LaunchTrackId; s: SceneId };
      if (trackId && sceneId)
        services.history.transact(e.altKey ? 'Copy launcher slot' : 'Move launcher slot', (d) => void moveSlot(d, { trackId: from.t, sceneId: from.s }, { trackId, sceneId }, e.altKey));
    } catch {
      /* not ours */
    }
  };

  return (
    <div
      ref={ref}
      className={`${styles.slot} ${cursor ? styles.cursor : ''}`}
      style={color ? ({ ['--c' as string]: color } as React.CSSProperties) : undefined}
      data-slot=""
      data-state={slot ? 'idle' : 'empty'}
      data-track-id={trackId}
      data-scene-id={sceneId}
      data-ti={ti}
      data-si={si}
      data-off-page={off ? '' : undefined}
      {...{ [CLIP_DROP_ATTR]: '' }}
      data-dj-target={`launch.slot:${(ti % LAUNCH_PAD_SIZE) + 1}:${(si % LAUNCH_PAD_SIZE) + 1}`}
      data-hint={
        slot
          ? `${label}: press to launch (${MODE_LABELS[mode].toLowerCase()}${slotLoops(slot) ? ', loops' : ', plays once'}); right-click for mode, loop, quantize and follow action`
          : 'Empty slot: drag a pattern here from the Browser, a clip from the playlist or an audio file from your computer, or right-click to choose what it plays'
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        session.setCursor(ti, si);
        (e.currentTarget.closest('[data-window-focus]') as HTMLElement | null)?.focus({ preventScroll: true });
        if (slot) session.pressAt(ti, si, true);
      }}
      onPointerUp={() => slot && session.pressAt(ti, si, false)}
      onPointerCancel={() => slot && session.pressAt(ti, si, false)}
      onContextMenu={(e) => {
        e.preventDefault();
        session.setCursor(ti, si);
        slotMenu(services, e, trackId as LaunchTrackId, sceneId as SceneId, ti, si);
      }}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (types.includes(PATTERN_DRAG) || types.includes(SLOT_DRAG) || dragMayHaveAudio(e.dataTransfer)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = types.includes(SLOT_DRAG) && !e.altKey ? 'move' : 'copy';
          ref.current?.classList.add(styles.drop as string);
        }
      }}
      onDragLeave={() => ref.current?.classList.remove(styles.drop as string)}
      onDrop={onDrop}
    >
      <span className={styles.ring} aria-hidden="true">
        {slot ? <Icon name="play" size={11} /> : <Icon name="plus" size={11} />}
      </span>
      <span className={styles.text}>
        <span className={styles.name}>{slot ? label : ''}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </span>
      {slot && trackId && sceneId && (
        <span
          className={styles.grip}
          draggable
          onPointerDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.dataTransfer.setData(SLOT_DRAG, JSON.stringify({ t: trackId, s: sceneId }));
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          data-hint="Drag to move this slot to another place (hold Alt to copy it)"
        >
          ⠿
        </span>
      )}
    </div>
  );
});

function SceneButton({ sceneId, index, name, off }: { sceneId: SceneId | undefined; index: number; name: string | undefined; off: boolean }) {
  const services = useServices();
  return (
    <button
      className={styles.scene}
      data-scene-btn={sceneId}
      data-state="idle"
      data-off-page={off ? '' : undefined}
      data-dj-target={`launch.scene:${(index % LAUNCH_PAD_SIZE) + 1}`}
      onClick={() => services.launcher.launchSceneAt(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (sceneId) sceneMenu(services, e, sceneId, index);
      }}
      disabled={!sceneId}
      data-hint={`${name ?? `Scene ${index + 1}`}: launch every slot of this row together (key ${index < 9 ? index + 1 : '–'}); right-click to rename`}
    >
      <Icon name="play" size={12} />
      <span className={styles.sceneName}>{name ?? `Scene ${index + 1}`}</span>
    </button>
  );
}

function StopButton({ trackId, index, off }: { trackId: LaunchTrackId | undefined; index: number; off: boolean }) {
  const services = useServices();
  return (
    <button
      className={styles.stop}
      data-stop-btn={trackId}
      data-state="idle"
      data-off-page={off ? '' : undefined}
      data-dj-target={`launch.stop:${(index % LAUNCH_PAD_SIZE) + 1}`}
      onClick={() => services.launcher.stopTrackAt(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (trackId) services.launcher.stopTrack(trackId, true);
      }}
      disabled={!trackId}
      aria-label={`Stop track ${index + 1}`}
      data-hint="Stop this track at the next boundary (right-click: stop right now)"
    >
      <Icon name="stop" size={12} />
    </button>
  );
}

