import { Fragment, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import { fillFromClips, fillFromPatterns, putClipsAt } from '@app/launcher/edit';
import { DEFAULT_SCENES, DEFAULT_TRACKS, QUANTIZE_LABELS, filledSlots } from '@core/launcher/grid';
import { LAUNCH_QUANTIZES, type Launcher, type LaunchQuantize, type LaunchTrackId } from '@core/model/types';
import { LAUNCH_PAD_SIZE } from '@core/midi-map/targets';
import { addLaunchTrack, addScene, setLauncherQuantize } from '@core/ops/launcher';
import { CLIP_DROP_EVENT, type ClipDropDetail } from '../../clip-drop';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import styles from './Launcher.module.css';
import { PageButtons, SceneButton, Slot, Status, StopButton, TrackHead, type PadPages } from './LauncherCells';
import { LauncherView } from './view-controller';

export const EMPTY_TITLE = 'Nothing to launch yet';
export const EMPTY_TEXT =
  'Drag a pattern from the Browser, a clip from the playlist or an audio file from your computer into a slot, or right-click a slot to choose one. Then press a slot (or a scene) to start it in time with the song: patterns loop, one slot plays per track, and a new one replaces it on the next bar.';

/** The grid's column widths (CSS): a track column and the scene-button column, in px with room to grow. */
const TRACK_COLUMN_WIDTH = 'minmax(104px, 1fr)';
const SCENE_COLUMN_WIDTH = 'minmax(120px, 150px)';

/**
 * The pads (a controller) show one 8 × 8 page at a time: with a bigger grid the rest is dimmed, and arrows move the page.
 * `pad` is the page the controller is on, kept inside the grid even if the grid shrank since.
 */
function padPagesFor(trackCount: number, sceneCount: number, page: { track: number; scene: number }) {
  const pages: PadPages = {
    tracks: Math.max(1, Math.ceil(trackCount / LAUNCH_PAD_SIZE)),
    scenes: Math.max(1, Math.ceil(sceneCount / LAUNCH_PAD_SIZE)),
  };
  const isPaged = pages.tracks > 1 || pages.scenes > 1;
  const pad = { track: Math.min(page.track, pages.tracks - 1), scene: Math.min(page.scene, pages.scenes - 1) };
  return {
    pages,
    isPaged,
    pad,
    isTrackOnPage: (trackIndex: number) => !isPaged || Math.floor(trackIndex / LAUNCH_PAD_SIZE) === pad.track,
    isSceneOnPage: (sceneIndex: number) => !isPaged || Math.floor(sceneIndex / LAUNCH_PAD_SIZE) === pad.scene,
  };
}

/** The live play states are painted by a frame callback (`LauncherView`), not by React. */
function useLauncherView(rootRef: RefObject<HTMLDivElement | null>, services: Services): void {
  const viewRef = useRef<LauncherView | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const view = new LauncherView(root, services);
    viewRef.current = view;
    view.refresh();
    view.start();
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [rootRef, services]);
  useLayoutEffect(() => viewRef.current?.refresh());
}

/** Playlist clips dragged here with the pointer (the playlist hands the drag over, see ui/clip-drop.ts) go into the slot under it. */
function useClipDrops(rootRef: RefObject<HTMLDivElement | null>, services: Services): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClipDrop = (e: Event) => {
      const slot = (e.target as Element).closest<HTMLElement>('[data-slot]');
      if (!slot) return;
      const { clipIds } = (e as CustomEvent<ClipDropDetail>).detail;
      const result = putClipsAt(services, clipIds, Number(slot.dataset.ti), Number(slot.dataset.si));
      const toast = services.session.getState().toast;
      if (!result.placed) {
        toast('Nothing to put there: automation clips can’t be launched.', 'error');
        return;
      }
      const noun = result.placed === 1 ? 'clip' : 'clips';
      const skippedNote = result.skipped ? ` (${result.skipped} could not go: automation clips can’t be launched)` : '';
      toast(`Put ${result.placed} ${noun} in the launcher${skippedNote}. Undo takes them back.`);
    };
    root.addEventListener(CLIP_DROP_EVENT, onClipDrop);
    return () => root.removeEventListener(CLIP_DROP_EVENT, onClipDrop);
  }, [rootRef, services]);
}

/** Moving the pads to another page scrolls that page's first slot into view. */
function useScrollToPadPage(rootRef: RefObject<HTMLDivElement | null>, isPaged: boolean, pad: { track: number; scene: number }): void {
  useEffect(() => {
    if (!isPaged) return;
    const firstTrack = pad.track * LAUNCH_PAD_SIZE;
    const firstScene = pad.scene * LAUNCH_PAD_SIZE;
    rootRef.current?.querySelector(`[data-ti="${firstTrack}"][data-si="${firstScene}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Only a change of page scrolls, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad.track, pad.scene]);
}

/** The clip launcher: perform and jam with the project's patterns and audio clips. */
export function LauncherWindow() {
  const services = useServices();
  const session = services.launcher;
  const launcher = useDoc((p) => p.launcher);
  const cursor = useStore(session.store, (s) => s.cursor);
  const page = useStore(session.store, (s) => s.page);
  const rootRef = useRef<HTMLDivElement>(null);

  const trackIds = launcher?.trackOrder ?? [];
  const sceneIds = launcher?.sceneOrder ?? [];
  const trackCount = launcher ? trackIds.length : DEFAULT_TRACKS;
  const sceneCount = launcher ? sceneIds.length : DEFAULT_SCENES;
  const isEmpty = filledSlots(launcher).length === 0;
  const padPages = padPagesFor(trackCount, sceneCount, page);

  useLauncherView(rootRef, services);
  useClipDrops(rootRef, services);
  useScrollToPadPage(rootRef, padPages.isPaged, padPages.pad);

  // Gate slots stop when the key is let go.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Enter') session.pressAt(cursor.track, cursor.scene, false);
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      tabIndex={-1}
      role="group"
      aria-label="Clip launcher"
      onKeyUp={onKeyUp}
      data-tour="launcher"
      data-window-focus="launcher"
      data-hint="Clip launcher: arrow keys move the highlight, Enter launches the highlighted slot, number keys launch scenes, the period key stops its track"
    >
      <LauncherBar launcher={launcher} padPages={padPages} />
      <LauncherGrid launcher={launcher} trackCount={trackCount} sceneCount={sceneCount} cursor={cursor} padPages={padPages} />
      {isEmpty && <EmptyLauncher />}
      <Status />
    </div>
  );
}

/** The bar on top: launch quantize, Stop all, Record performance, add a scene or track, the pad page arrows and Pads…. */
function LauncherBar({ launcher, padPages }: { launcher: Launcher | undefined; padPages: ReturnType<typeof padPagesFor> }) {
  const services = useServices();
  const session = services.launcher;
  const recording = useStore(session.store, (s) => s.recording);
  return (
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
      <button
        className={styles.button}
        onClick={() => session.stopAll()}
        data-hint="Stop every track at the next boundary (right-click for an immediate stop)"
        onContextMenu={(e) => {
          e.preventDefault();
          session.stopAll(true);
        }}
      >
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
      {padPages.isPaged && <PageButtons track={padPages.pad.track} scene={padPages.pad.scene} pages={padPages.pages} />}
      <button className={styles.button} onClick={() => void services.commands.run('dj.controllers.open')} data-hint="Connect a pad controller (Launchpad and similar) or link pads with MIDI learn">
        <Icon name="midi" size={12} /> Pads…
      </button>
    </div>
  );
}

interface LauncherGridProps {
  launcher: Launcher | undefined;
  trackCount: number;
  sceneCount: number;
  /** The keyboard highlight. */
  cursor: { track: number; scene: number };
  padPages: ReturnType<typeof padPagesFor>;
}

/** The grid: track heads on top, a row of slots and a scene button per scene, and a stop button under each track. */
function LauncherGrid({ launcher, trackCount, sceneCount, cursor, padPages }: LauncherGridProps) {
  const trackIds = launcher?.trackOrder ?? [];
  const sceneIds = launcher?.sceneOrder ?? [];
  const { isTrackOnPage, isSceneOnPage } = padPages;
  return (
    <div className={styles.scroll}>
      <div
        className={styles.grid}
        style={{ gridTemplateColumns: `repeat(${trackCount}, ${TRACK_COLUMN_WIDTH}) ${SCENE_COLUMN_WIDTH}` }}
        role="group"
        aria-label="Launcher grid: scenes down, tracks across"
        data-roving="grid"
      >
        {Array.from({ length: trackCount }, (_, ti) => (
          <TrackHead key={trackIds[ti] ?? `t${ti}`} track={launcher?.tracks[trackIds[ti] as LaunchTrackId]} index={ti} off={!isTrackOnPage(ti)} />
        ))}
        <div className={styles.corner} data-hint="Scene buttons: launch a whole row of slots together">
          Scenes
        </div>
        {Array.from({ length: sceneCount }, (_, si) => {
          const sceneId = sceneIds[si];
          return (
            <Fragment key={sceneId ?? `s${si}`}>
              {Array.from({ length: trackCount }, (_, ti) => {
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
                    off={!isTrackOnPage(ti) || !isSceneOnPage(si)}
                  />
                );
              })}
              <SceneButton sceneId={sceneId} index={si} name={sceneId ? launcher?.scenes[sceneId]?.name : undefined} off={!isSceneOnPage(si)} />
            </Fragment>
          );
        })}
        {Array.from({ length: trackCount }, (_, ti) => (
          <StopButton key={trackIds[ti] ?? `t${ti}`} trackId={trackIds[ti]} index={ti} off={!isTrackOnPage(ti)} />
        ))}
        <div />
      </div>
    </div>
  );
}

/** What the window says while no slot has anything: how to fill the grid, with two one-click ways. */
function EmptyLauncher() {
  const services = useServices();
  const putPatternsInGrid = () => {
    const count = fillFromPatterns(services);
    services.session.getState().toast(`Put ${count} pattern${count === 1 ? '' : 's'} in the first track, one per scene.`);
  };
  const sendSelectedClips = () => {
    const selection = services.editor.getState().clipSelection;
    const result = fillFromClips(services, selection);
    const message = result.placed
      ? `Sent ${result.placed} clip${result.placed === 1 ? '' : 's'} to the launcher.`
      : 'Select clips in the playlist first (patterns or audio).';
    services.session.getState().toast(message, result.placed ? 'info' : 'error');
  };
  return (
    <div className={styles.empty} role="status">
      <div className={styles.emptyTitle}>{EMPTY_TITLE}</div>
      <div className={styles.emptyText}>{EMPTY_TEXT}</div>
      <div className={styles.emptyActions}>
        <button className={styles.button} onClick={putPatternsInGrid} data-hint="Fill the first track with your patterns, one in each scene, ready to launch">
          Put my patterns in the grid
        </button>
        <button className={styles.button} onClick={sendSelectedClips} data-hint="Put the clips selected in the playlist into free slots (a playlist track becomes a launcher track)">
          Send selected playlist clips
        </button>
      </div>
    </div>
  );
}
