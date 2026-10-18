/** The event lane under the grid (velocity, pan, release, fine pitch): drag to draw a value for each note, right-drag to reset. */
import { editNotes } from '@core/ops/notes';
import { formatLaneAmount, formatLaneValue, laneEdit, LANES, valueAtY } from '../lanes';
import type { EditTarget, PianoRollContext } from './context';
import { showHint } from './cursor';
import { localPoint } from './hit-test';
import { editTarget } from './target';

/** A drag covers the notes within this many px either side of where the pointer has been (px). */
const LANE_REACH_PX = 3;

/** A press in the lane (left button writes values, right button resets them). */
export function onLaneDown(ctx: PianoRollContext, event: PointerEvent): void {
  const target = editTarget(ctx);
  if ((event.button !== 0 && event.button !== 2) || !target.channelId || !target.patternId) return;
  event.preventDefault();
  ctx.els.velocityHost.setPointerCapture(event.pointerId);
  const { x } = localPoint(ctx, event, ctx.els.velocityHost);
  const lane = ctx.s.editor.getState().pianoRoll.lane;
  // Right-drag resets values to their default.
  ctx.state.drag = { kind: 'lane', gesture: ctx.s.history.gesture(LANES[lane].label), lastX: x, reset: event.button === 2 };
  writeValues(ctx, event, target);
}

/** The pointer moved in the lane. */
export function onLaneMove(ctx: PianoRollContext, event: PointerEvent): void {
  if (ctx.state.drag?.kind !== 'lane') return;
  if (event.buttons === 0) {
    onLaneUp(ctx, event);
    return;
  }
  writeValues(ctx, event, editTarget(ctx));
}

/** The button was let go in the lane: the values drawn are one undo step. */
export function onLaneUp(ctx: PianoRollContext, event: PointerEvent): void {
  const drag = ctx.state.drag;
  if (drag?.kind !== 'lane') return;
  writeValues(ctx, event, editTarget(ctx));
  ctx.els.velocityHost.releasePointerCapture(event.pointerId);
  drag.gesture.commit();
  ctx.state.drag = null;
  ctx.els.laneValue.textContent = '';
}

/** Gives the notes between the last and the current pointer position the value at the pointer's height. */
function writeValues(ctx: PianoRollContext, event: PointerEvent, target: EditTarget): void {
  const drag = ctx.state.drag;
  const { patternId, channelId } = target;
  if (drag?.kind !== 'lane' || !patternId || !channelId) return;
  const host = ctx.els.velocityHost;
  const { x, y } = localPoint(ctx, event, host);
  const laneHeight = host.getBoundingClientRect().height;
  const lane = ctx.s.editor.getState().pianoRoll.lane;
  const value = drag.reset ? LANES[lane].reset : valueAtY(y, laneHeight, lane);
  showHint(ctx, formatLaneValue(lane, value));
  ctx.els.laneValue.textContent = formatLaneAmount(lane, value);
  const firstTick = ctx.vp.xToTick(Math.min(drag.lastX, x) - LANE_REACH_PX);
  const lastTick = ctx.vp.xToTick(Math.max(drag.lastX, x) + LANE_REACH_PX);
  drag.lastX = x;
  const selected = ctx.s.editor.getState().noteSelection;
  // With notes selected, only they change.
  const only = selected.length > 0 ? new Set(selected) : null;
  const edits = target.notes
    .filter((note) => note.tick >= firstTick && note.tick <= lastTick && (!only || only.has(note.id)))
    .map((note) => laneEdit(note.id, lane, value));
  if (edits.length === 0) return;
  drag.gesture.update((draft) => editNotes(draft, patternId, channelId, edits));
}
