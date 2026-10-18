/**
 * The imperative playlist editor (same architecture as the piano roll): canvases for the track headers, the ruler and
 * the clips, redrawn on the frame loop when dirty. Geometry drags preview while the pointer is down and commit once, as
 * one undo step.
 *
 * This class is the window's handle on the editor: it builds the shared context, wires the events and stores, runs the
 * frame, and exposes what the window and the Ask AI card need. The work itself lives in `./control/`, one module per
 * job (drawing a layer, one tool's pointer handling, the ruler, the track headers...).
 */
import type { Services } from '@app/services';
import type { MarkerId, LaneId, Tick } from '@core/model/types';
import { onFrame } from '../../frame-loop';
import { CleanupList } from '../../timeline/listeners';
import type { Viewport } from '../../timeline/viewport';
import {
  createPlaylistContext,
  type ClientBox,
  type Layer,
  type PlaylistContext,
  type PlaylistElements,
  type PlaylistHooks,
} from './control/context';
import { runFrame } from './control/frame';
import { renameLane } from './control/header-pointer';
import { createLayerDrawers, type LayerDrawers } from './control/layers';
import { renameMarker } from './control/marker-rename';
import { cancelDrag } from './control/pointer';
import { markerBox, pillBox, spanBox } from './control/screen-boxes';
import { currentProject } from './control/lanes';
import { measureLayout, revealSpan, zoomBy } from './control/viewport-control';
import { forgetPointerClip, listenToElements, subscribeToChanges } from './control/wiring';

export type { ClientBox, PlaylistElements };

export class PlaylistController implements PlaylistHooks {
  /** The view onto the song (scroll and zoom); the chord lane above the playlist reads it every frame to stay lined up. */
  readonly vp: Viewport;
  private readonly ctx: PlaylistContext;
  private readonly drawers: LayerDrawers;
  private readonly cleanups = new CleanupList();

  // What the window plugs in (see PlaylistHooks): menus to open and drops to handle.
  onSampleDrop?: PlaylistHooks['onSampleDrop'];
  onFilesDrop?: PlaylistHooks['onFilesDrop'];
  onClipMenu?: PlaylistHooks['onClipMenu'];
  onPointMenu?: PlaylistHooks['onPointMenu'];
  onLaneMenu?: PlaylistHooks['onLaneMenu'];
  onMarkerMenu?: PlaylistHooks['onMarkerMenu'];
  onRulerMenu?: PlaylistHooks['onRulerMenu'];
  onEmptyMenu?: PlaylistHooks['onEmptyMenu'];
  onMarkerAsk?: PlaylistHooks['onMarkerAsk'];

  constructor(s: Services, els: PlaylistElements) {
    this.ctx = createPlaylistContext(s, els, this);
    this.vp = this.ctx.vp;
    this.drawers = createLayerDrawers(this.ctx);
  }

  /** Starts listening to the app and the elements, and draws. */
  mount(): void {
    subscribeToChanges(this.ctx, this.cleanups);
    this.cleanups.add(onFrame(() => runFrame(this.ctx, this.drawers)));
    listenToElements(this.ctx, this.cleanups);
    measureLayout(this.ctx);
  }

  /** Stops listening and saves the view. */
  unmount(): void {
    forgetPointerClip();
    cancelDrag(this.ctx);
    this.cleanups.runAll();
    this.ctx.viewportSaver.flush();
  }

  /** Marks layers to be drawn on the next frame. */
  invalidate(...layers: Layer[]): void {
    this.ctx.invalidate(...layers);
  }

  /** Shows the inline rename field on a track header. */
  renameLane(laneId: LaneId): void {
    renameLane(this.ctx, laneId);
  }

  /** Shows the inline rename field on a marker's flag. */
  renameMarker(id: MarkerId): void {
    renameMarker(this.ctx, id);
  }

  /** The toolbar's zoom buttons. */
  zoomBy(factor: number): void {
    zoomBy(this.ctx, factor);
  }

  /** The Ask AI pill on screen (null while it is hidden). */
  pillBox(): ClientBox | null {
    return pillBox(this.ctx);
  }

  /** A marker's flag on screen (null when it is scrolled away or the playlist is hidden). */
  markerBox(id: MarkerId): ClientBox | null {
    return markerBox(this.ctx, id);
  }

  /** A span of the song on the ruler (null when it is scrolled away or the playlist is hidden). */
  spanBox(from: Tick, to: Tick): ClientBox | null {
    return spanBox(this.ctx, from, to);
  }

  /** Scrolls so the span starts on screen (a little in from the left edge); true when it scrolled or already showed it. */
  revealSpan(from: Tick, to: Tick): boolean {
    return revealSpan(this.ctx, from, to);
  }

  /** Scrolls a marker's flag into view. */
  revealMarker(id: MarkerId): boolean {
    const marker = currentProject(this.ctx).playlist.markers[id];
    return marker ? revealSpan(this.ctx, marker.tick, marker.tick + 1) : false;
  }
}
