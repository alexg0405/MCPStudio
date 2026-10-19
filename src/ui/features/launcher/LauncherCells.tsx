/** The cells of the clip launcher's grid: track heads, slots, scene and stop buttons, the pad page arrows and the status line. */
import { memo, useRef, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { MODE_LABELS, slotColor, slotLabel, slotLoops, slotMode } from '@core/launcher/grid';
import type { LaunchSlot, LaunchTrack, LaunchTrackId, SceneId } from '@core/model/types';
import { LAUNCH_PAD_SIZE, type LaunchPageDir } from '@core/midi-map/targets';
import { CLIP_DROP_ATTR } from '../../clip-drop';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import styles from './Launcher.module.css';
import { sceneMenu, slotMenu, trackMenu } from './menus';
import { canDropOnSlot, dropOnSlot, slotDropEffect, startSlotDrag } from './slot-drop';

/** The pad number (1 to 8) a grid position has on the controller, which shows one 8 × 8 page at a time. */
const padNumber = (index: number) => (index % LAUNCH_PAD_SIZE) + 1;

/** One line under the grid: what the cursor is on, or how to use the grid. */
export function Status() {
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

/** How many 8 × 8 pad pages the grid has across and down. */
export interface PadPages {
  tracks: number;
  scenes: number;
}

/** The pad page: arrows move the 8 × 8 page the controller pads show (only when the grid is bigger than one page). */
export function PageButtons({ track, scene, pages }: { track: number; scene: number; pages: PadPages }) {
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

/** The name at the top of a track's column; right-click to rename, colour it or tie it to a playlist track. */
export const TrackHead = memo(function TrackHead({ track, index, off }: { track: LaunchTrack | undefined; index: number; off: boolean }) {
  const services = useServices();
  const laneName = useDoc((p) => (track?.laneId ? p.playlist.lanes[track.laneId]?.name : undefined));
  return (
    <div
      className={styles.head}
      data-off-page={off ? '' : undefined}
      style={track?.color ? ({ ['--c' as string]: track.color } as CSSProperties) : undefined}
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
  /** The column and row of the slot (0-based), and the ids there (none beyond the real tracks and scenes). */
  ti: number;
  si: number;
  trackId: LaunchTrackId | undefined;
  sceneId: SceneId | undefined;
  slot: LaunchSlot | undefined;
  track: LaunchTrack | undefined;
  /** The keyboard highlight is on this slot. */
  cursor: boolean;
  /** Not on the page the controller pads show. */
  off: boolean;
}

/** A short line under a slot's name: its mode when it is not the plain trigger, "1×" when it plays once, "↦" with a follow action. */
function slotMeta(slot: LaunchSlot | undefined): string {
  if (!slot) return '';
  const mode = slotMode(slot);
  const parts = [mode === 'trigger' ? '' : MODE_LABELS[mode].toLowerCase(), slotLoops(slot) ? '' : '1×', slot.follow ? '↦' : ''];
  return parts.filter(Boolean).join(' ');
}

/** One slot of the grid: press it to launch, drop a pattern, clip or audio file on it, drag its grip to move it. */
export const Slot = memo(function Slot({ ti, si, trackId, sceneId, slot, track, cursor, off }: SlotProps) {
  const services = useServices();
  const session = services.launcher;
  const label = useDoc((p) => (slot ? slotLabel(p, slot) : ''));
  const color = useDoc((p) => (slot ? slotColor(p, slot, track) : ''));
  const mode = slot ? slotMode(slot) : 'trigger';
  const meta = slotMeta(slot);
  const ref = useRef<HTMLDivElement>(null);
  const dropClass = styles.drop as string;

  return (
    <div
      ref={ref}
      className={`${styles.slot} ${cursor ? styles.cursor : ''}`}
      style={color ? ({ ['--c' as string]: color } as CSSProperties) : undefined}
      data-slot=""
      data-state={slot ? 'idle' : 'empty'}
      data-track-id={trackId}
      data-scene-id={sceneId}
      data-ti={ti}
      data-si={si}
      data-off-page={off ? '' : undefined}
      {...{ [CLIP_DROP_ATTR]: '' }}
      data-dj-target={`launch.slot:${padNumber(ti)}:${padNumber(si)}`}
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
        if (!canDropOnSlot(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = slotDropEffect(e.dataTransfer, e.altKey);
        ref.current?.classList.add(dropClass);
      }}
      onDragLeave={() => ref.current?.classList.remove(dropClass)}
      onDrop={(e) => {
        ref.current?.classList.remove(dropClass);
        dropOnSlot(services, e, { trackIndex: ti, sceneIndex: si, trackId, sceneId });
      }}
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
          onDragStart={(e) => startSlotDrag(e, trackId, sceneId)}
          data-hint="Drag to move this slot to another place (hold Alt to copy it)"
        >
          ⠿
        </span>
      )}
    </div>
  );
});

/** The button at the end of a scene's row: launches every slot of the row together. */
export function SceneButton({ sceneId, index, name, off }: { sceneId: SceneId | undefined; index: number; name: string | undefined; off: boolean }) {
  const services = useServices();
  return (
    <button
      className={styles.scene}
      data-scene-btn={sceneId}
      data-state="idle"
      data-off-page={off ? '' : undefined}
      data-dj-target={`launch.scene:${padNumber(index)}`}
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

/** The button under a track's column: stops the track at the next boundary (right-click: right now). */
export function StopButton({ trackId, index, off }: { trackId: LaunchTrackId | undefined; index: number; off: boolean }) {
  const services = useServices();
  return (
    <button
      className={styles.stop}
      data-stop-btn={trackId}
      data-state="idle"
      data-off-page={off ? '' : undefined}
      data-dj-target={`launch.stop:${padNumber(index)}`}
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
