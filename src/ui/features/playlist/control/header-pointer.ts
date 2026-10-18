/** The track header column: mute light, solo, the take buttons, the track menu and renaming a track. */
import { listenToTake } from '@app/actions/comp';
import type { ClipId, Lane, LaneId, Project } from '@core/model/types';
import { setLaneProps, toggleSoloLane } from '@core/ops/playlist';
import { takeClipOnLane } from '@core/query/takes';
import { FOLD_ZONE, HEADER_LIGHT_ZONE, HEADER_WIDTH, LISTEN_ZONE, RULER_HEIGHT } from '../layout';
import type { PlaylistContext } from './context';
import { editInline } from './inline-field';
import { localPoint } from './hit-test';
import { currentProject, laneAtY, laneRow } from './lanes';

/** A press on a take track's speaker held longer than this (ms) listens only while it is held. */
const HOLD_LISTEN_MS = 350;
/** The rename field is placed this far (px) below the top of its track and at least this tall. */
const RENAME_FIELD_TOP_GAP = 4;
const RENAME_FIELD_MIN_HEIGHT = 16;
/** The rename field is this much shorter than the track (px), top and bottom gaps together. */
const RENAME_FIELD_VERTICAL_GAPS = 8;

/** A press in the header column: the light mutes (right button: solo), the buttons of take tracks, the track menu. */
export function onHeaderDown(ctx: PlaylistContext, event: PointerEvent): void {
  const project = currentProject(ctx);
  const { x, y } = localPoint(ctx, event, ctx.els.headers);
  const laneId = laneAtY(ctx, y, project);
  if (!laneId) return;
  event.preventDefault();
  const isLeftButton = event.button === 0;
  if (x >= HEADER_LIGHT_ZONE && event.button === 2) {
    ctx.hooks.onLaneMenu?.(laneId, event);
    return;
  }
  const takes = project.playlist.lanes[laneId]?.takes;
  if (takes?.role === 'take' && isLeftButton && x >= HEADER_WIDTH - LISTEN_ZONE) {
    pressSpeaker(ctx, project, laneId);
    return;
  }
  if (takes?.role === 'comp' && isLeftButton && x >= HEADER_WIDTH - FOLD_ZONE) {
    // The ▸ / ▾ at the right end of a comp track opens or folds its takes.
    const editor = ctx.s.editor.getState();
    editor.setTakesOpen(takes.group, !editor.openTakes.includes(takes.group));
    return;
  }
  if (x < HEADER_LIGHT_ZONE) pressLight(ctx, project, laneId, event.button);
}

/**
 * The speaker on a take track: listen to that take alone. A quick click switches it on (click again to go back); holding
 * it down listens only while it is pressed.
 */
function pressSpeaker(ctx: PlaylistContext, project: Project, laneId: LaneId): void {
  const clip = takeClipOnLane(project, laneId);
  if (!clip) return;
  if (ctx.s.editor.getState().auditionTake === clip) {
    listenToTake(ctx.s, null, false);
    return;
  }
  listenToTake(ctx.s, clip, true);
  stopListeningWhenReleasedAfterHold(ctx, clip);
}

/** When the button is let go after a hold (not a quick click), the take stops playing alone. */
function stopListeningWhenReleasedAfterHold(ctx: PlaylistContext, clip: ClipId): void {
  const pressedAt = performance.now();
  const onRelease = (): void => {
    window.removeEventListener('pointerup', onRelease);
    window.removeEventListener('pointercancel', onRelease);
    const wasHeld = performance.now() - pressedAt > HOLD_LISTEN_MS;
    if (wasHeld && ctx.s.editor.getState().auditionTake === clip) listenToTake(ctx.s, null, false);
  };
  window.addEventListener('pointerup', onRelease);
  window.addEventListener('pointercancel', onRelease);
}

/** The mute light: a click mutes or unmutes the track, a right-click solos it. */
function pressLight(ctx: PlaylistContext, project: Project, laneId: LaneId, button: number): void {
  if (button === 2) {
    ctx.s.history.transact('Solo track', (draft) => toggleSoloLane(draft, laneId));
  } else if (button === 0) {
    const isMuted = !!project.playlist.lanes[laneId]?.muted;
    ctx.s.history.transact(isMuted ? 'Unmute track' : 'Mute track', (draft) => setLaneProps(draft, laneId, { muted: !isMuted }));
  }
}

/** A double-click on a track's name renames it. */
export function onHeaderDouble(ctx: PlaylistContext, event: MouseEvent): void {
  const project = currentProject(ctx);
  const { x, y } = localPoint(ctx, event, ctx.els.headers);
  const laneId = laneAtY(ctx, y, project);
  if (laneId && x >= HEADER_LIGHT_ZONE) renameLane(ctx, laneId);
}

/** Shows the inline rename field on a track header. */
export function renameLane(ctx: PlaylistContext, laneId: LaneId): void {
  const project = currentProject(ctx);
  const lane: Lane | undefined = project.playlist.lanes[laneId];
  if (!lane) return;
  const input = ctx.els.rename;
  const row = laneRow(ctx, project, lane.id);
  input.style.top = `${RULER_HEIGHT + ctx.vp.rowToY(row) + RENAME_FIELD_TOP_GAP}px`;
  input.style.height = `${Math.max(RENAME_FIELD_MIN_HEIGHT, ctx.vp.rowHeight - RENAME_FIELD_VERTICAL_GAPS)}px`;
  editInline(input, lane.name, (typed) => {
    const name = typed.trim();
    if (name && name !== lane.name) ctx.s.history.transact('Rename track', (draft) => setLaneProps(draft, lane.id, { name }));
  });
}
