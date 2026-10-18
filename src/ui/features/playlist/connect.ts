/** Connecting the playlist editor to the rest of the app: the menus its clicks open, what drops do, where the Ask AI card sits. */
import { addAudioClip, addKitAudioClip, importAudioFile } from '@app/actions/samples';
import type { Services } from '@app/services';
import type { LaneId, Tick } from '@core/model/types';
import { showContextMenu } from '../../controls/ContextMenu';
import { pointMenu } from '../automation/actions';
import { registerAnchorSource } from '../ask-ai/anchors';
import { askAboutMarker } from '../ask-ai/ask-state';
import type { PlaylistController } from './controller';
import { emptyMenu } from './empty-menu';
import { markerMenu, rulerMenu } from './markers';
import { clipMenu, laneMenu } from './menus';

/** FL behaviour: several files dropped at once go on consecutive tracks, all starting at the drop point. */
async function dropAudioFiles(s: Services, files: Promise<File[]>, laneId: LaneId, tick: Tick): Promise<void> {
  const lanes = s.doc.getState().project.playlist.laneOrder;
  let lane = lanes.indexOf(laneId);
  for (const file of await files) {
    const ref = await importAudioFile(s, file);
    const target = lanes[Math.min(lane, lanes.length - 1)];
    if (ref && target) {
      addAudioClip(s, ref, target, tick);
      lane++;
    }
  }
}

/** Gives the controller the menus and drop handlers of the app. Call it before `mount()`. */
export function connectPlaylistController(services: Services, controller: PlaylistController): void {
  controller.onSampleDrop = (generator, laneId, tick) => addKitAudioClip(services, generator, laneId, tick);
  controller.onFilesDrop = (files, laneId, tick) => void dropAudioFiles(services, files, laneId, tick);
  controller.onClipMenu = (clip, at) => showContextMenu(at, clipMenu(services, clip));
  controller.onPointMenu = (clip, index, at) => showContextMenu(at, pointMenu(services, clip, index));
  controller.onMarkerMenu = (id, at) => showContextMenu(at, markerMenu(services, id));
  controller.onRulerMenu = (tick, at) => showContextMenu(at, rulerMenu(services, tick));
  controller.onEmptyMenu = (tick, laneId, at) => {
    const items = emptyMenu(services, tick, laneId, () => controller.renameLane(laneId));
    if (items.length) showContextMenu(at, items);
  };
  // A flag's Studio mark: loop that section and open the Ask AI card on it.
  controller.onMarkerAsk = (id, at) =>
    void askAboutMarker(services, id, { kind: 'marker', markerId: id, fallback: { x: at.clientX, y: at.clientY } });
  controller.onLaneMenu = (laneId, at) =>
    showContextMenu(
      at,
      laneMenu(services, laneId, () => controller.renameLane(laneId)),
    );
}

/** Registers where the Ask AI card sits: the pill, a marker's flag, bars on the ruler. Returns the function that removes it. */
export function registerPlaylistAnchors(controller: PlaylistController): () => void {
  return registerAnchorSource(
    'playlist',
    (anchor) => {
      if (anchor.kind === 'pill') return controller.pillBox();
      if (anchor.kind === 'marker') return controller.markerBox(anchor.markerId);
      if (anchor.kind === 'span') return controller.spanBox(anchor.from, anchor.to);
      return null;
    },
    (anchor) => {
      if (anchor.kind === 'marker') return controller.revealMarker(anchor.markerId);
      if (anchor.kind === 'span') return controller.revealSpan(anchor.from, anchor.to);
      return false;
    },
  );
}
