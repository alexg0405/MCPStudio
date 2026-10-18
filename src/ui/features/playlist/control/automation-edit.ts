/**
 * Editing automation clips in place on the playlist: what is under the pointer (a point, a curve handle, the curve),
 * the hint and cursor for it, adding points, and dragging points and curve handles.
 */
import { emitHint } from '@agstudio/sdk/ui';
import { pointBefore } from '@core/automation/curve';
import type { AutomationChannel, AutomationClip, ClipId, Project, Tick } from '@core/model/types';
import { addAutomationPoint, moveAutomationPoint, setAutomationPointTension } from '@core/ops/automation';
import { snapRound } from '@core/time/snap';
import { formatBST } from '@core/time/ppq';
import { clamp } from '../../../timeline/viewport';
import {
  AUTO_HINTS,
  contentToTick,
  hitAutomation,
  tickToContent,
  yToValue,
  type AutoDraw,
  type AutoHit,
} from '../automation';
import type { PlaylistContext, Hit } from './context';
import { updateCursor } from './cursor';
import type { AutoTarget, PointDrag, TensionDrag } from './drag';
import { boxOfClip } from './hit-test';
import { snapTicks } from './lanes';

/** Dragging a curve handle this many pixels up or down bends the curve from straight to its fullest. */
const TENSION_DRAG_PX = 60;
/** A bend smaller than this (of 1) is treated as straight, so "back to straight" is easy to hit. */
const STRAIGHT_BEND = 0.02;

/** The automation channel an automation clip plays, or null when it is gone. */
export function automationChannelOf(clip: AutomationClip, project: Project): AutomationChannel | null {
  const channel = project.channels[clip.channelId];
  return channel?.kind === 'automation' ? channel : null;
}

/** What an automation clip shows as its title: what it drives ("Cutoff · 3xOsc"). */
export function automationLabel(ctx: PlaylistContext, clip: AutomationClip, project: Project): string | undefined {
  const channel = automationChannelOf(clip, project);
  return channel ? ctx.s.automation.labelOf(channel, project) : undefined;
}

/** How an automation clip is drawn now: its points when selected, hovered or dragged, and a note when it needs one. */
export function automationDrawStyle(
  ctx: PlaylistContext,
  clip: AutomationClip,
  project: Project,
  selected: ReadonlySet<ClipId>,
): AutoDraw {
  const channel = automationChannelOf(clip, project);
  const drag = ctx.state.drag;
  const isDragged = (drag?.kind === 'point' || drag?.kind === 'tension') && drag.clip.id === clip.id;
  const isHovered = ctx.state.autoHover?.clipId === clip.id;
  let hot: AutoHit | null = null;
  if (isDragged) hot = { part: drag.kind === 'point' ? 'point' : 'handle', index: drag.index };
  else if (isHovered) hot = ctx.state.autoHover?.hit ?? null;
  const { note, isWarning } = automationNote(ctx, channel, project);
  return { showPoints: selected.has(clip.id) || isHovered || isDragged, hot, note, noteIsWarning: isWarning };
}

/** A line of explanation drawn in an automation clip that needs one: it drives nothing, or it is flat. */
function automationNote(
  ctx: PlaylistContext,
  channel: AutomationChannel | null,
  project: Project,
): { note: string | null; isWarning: boolean } {
  if (!channel) return { note: null, isWarning: false };
  if (!channel.target || ctx.s.automation.nameOf(channel.target, project) === null) {
    return { note: 'Drives nothing: what it controlled was deleted', isWarning: true };
  }
  const isFlat = channel.points.length <= 2 && channel.points.every((point) => point.value === channel.points[0]?.value);
  if (isFlat) return { note: 'Flat: double-click to add points', isWarning: false };
  return { note: null, isWarning: false };
}

/** The automation clip part at (`x`, `y`), when `hit` is an automation clip and the tool edits clips. */
export function automationTargetAt(
  ctx: PlaylistContext,
  hit: Hit | null,
  x: number,
  y: number,
  project: Project,
): AutoTarget | null {
  const tool = ctx.s.editor.getState().playlist.tool;
  if (!hit || hit.clip.kind !== 'automation' || tool === 'delete' || tool === 'slice') return null;
  const channel = automationChannelOf(hit.clip, project);
  const box = boxOfClip(ctx, hit.clip, project);
  if (!channel || !box) return null;
  const part = hitAutomation(ctx.vp, hit.clip, channel, box, x, y);
  return part ? { clip: hit.clip, ch: channel, box, hit: part } : null;
}

/** The hint for a part of an automation clip the pointer is on. */
function hintForPart(part: AutoHit['part'], label: string): string {
  switch (part) {
    case 'point':
      return AUTO_HINTS.point;
    case 'handle':
      return AUTO_HINTS.handle;
    case 'curve':
      return AUTO_HINTS.curve(label);
    case 'small':
      return AUTO_HINTS.small;
  }
}

function isSameHover(a: { clipId: ClipId; hit: AutoHit } | null, b: { clipId: ClipId; hit: AutoHit } | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.clipId !== b.clipId || a.hit.part !== b.hit.part) return false;
  const indexA = 'index' in a.hit ? a.hit.index : -1;
  const indexB = 'index' in b.hit ? b.hit.index : -1;
  return indexA === indexB;
}

/** Hover inside automation clips: points show, the cursor and the hint bar explain what a drag does. */
export function updateAutomationHover(ctx: PlaylistContext, hit: Hit | null, x: number, y: number, project: Project): void {
  const { state, els } = ctx;
  const target = automationTargetAt(ctx, hit, x, y, project);
  let next: { clipId: ClipId; hit: AutoHit } | null = null;
  let hint: string | null = null;
  if (target) {
    const label = ctx.s.automation.labelOf(target.ch, project);
    const part = target.hit.part;
    const isEditable = part === 'point' || part === 'handle' || hit?.zone === 'body';
    next = isEditable ? { clipId: target.clip.id, hit: target.hit } : null;
    hint = isEditable ? hintForPart(part, label) : AUTO_HINTS.title(label);
  } else if (hit?.clip.kind === 'automation') {
    const channel = automationChannelOf(hit.clip, project);
    if (channel) hint = AUTO_HINTS.title(ctx.s.automation.labelOf(channel, project));
  }
  if (!isSameHover(state.autoHover, next)) {
    state.autoHover = next;
    ctx.invalidate('clips');
    updateCursor(ctx);
  }
  if (hint !== state.lastHint) {
    state.lastHint = hint;
    emitHint(els.gridHost, hint ?? els.gridHost.getAttribute('data-hint') ?? '');
  }
}

/** The clip's content tick under `x` (on the grid unless Alt), kept inside the clip. */
function contentTickAt(ctx: PlaylistContext, clip: AutomationClip, x: number, project: Project, event: { altKey: boolean }): Tick {
  const songTick = Math.max(0, snapRound(ctx.vp.xToTick(x), snapTicks(ctx, project, event)));
  return clamp(tickToContent(clip, songTick), clip.offset, clip.offset + clip.length);
}

/** "42% · 2.1.1": a value in its units and where it is. */
function pointText(
  ctx: PlaylistContext,
  channel: AutomationChannel,
  clip: AutomationClip,
  tick: Tick,
  value: number,
  project: Project,
): string {
  const valueText = channel.target ? ctx.s.automation.format(channel.target, value, channel.range) : `${Math.round(value * 100)}%`;
  return `${valueText} · ${formatBST(contentToTick(clip, tick), project.transport.timeSig)}`;
}

/** Adds a point under the pointer (it takes the shape of the stretch it lands in). */
export function addAutomationPointAt(
  ctx: PlaylistContext,
  target: AutoTarget,
  x: number,
  y: number,
  project: Project,
  event: { altKey: boolean },
): void {
  const tick = contentTickAt(ctx, target.clip, x, project, event);
  const value = yToValue(y, target.box);
  const before = pointBefore(target.ch.points, tick);
  const shape = before >= 0 ? target.ch.points[before]?.shape : undefined;
  const channelId = target.ch.id;
  ctx.s.history.transact('Add automation point', (draft) => {
    addAutomationPoint(draft, channelId, { tick, value, ...(shape ? { shape } : {}) });
  });
  ctx.s.editor.getState().selectClips([target.clip.id]);
  emitHint(ctx.els.gridHost, `Added a point: ${pointText(ctx, target.ch, target.clip, tick, value, project)} · drag it to adjust`);
}

/**
 * A press on an automation clip's points or handles: the right button on a point opens its menu, on the curve it adds a
 * point; the left button on a point or curve handle starts dragging it. Returns true when it took the press.
 */
export function pressOnAutomation(
  ctx: PlaylistContext,
  target: AutoTarget | null,
  x: number,
  y: number,
  event: PointerEvent,
  project: Project,
): boolean {
  if (!target) return false;
  const editor = ctx.s.editor.getState();
  const part = target.hit.part;
  if (event.button === 2 && part !== 'small') {
    ctx.els.gridHost.releasePointerCapture(event.pointerId);
    if (target.hit.part === 'point') {
      editor.selectClips([target.clip.id]);
      ctx.hooks.onPointMenu?.(target.clip, target.hit.index, event);
    } else {
      addAutomationPointAt(ctx, target, x, y, project, event);
    }
    return true;
  }
  if (event.button !== 0 || (target.hit.part !== 'point' && target.hit.part !== 'handle')) return false;
  editor.selectClips([target.clip.id]);
  if (target.hit.part === 'point') startPointDrag(ctx, target, target.hit.index);
  else startTensionDrag(ctx, target, target.hit.index, y);
  updateCursor(ctx);
  ctx.invalidate('clips');
  return true;
}

/** Starts dragging point number `index` of the target's curve (one undo step for the whole drag). */
export function startPointDrag(ctx: PlaylistContext, target: AutoTarget, index: number): void {
  ctx.state.drag = {
    kind: 'point',
    gesture: ctx.s.history.gesture('Move automation point'),
    clip: target.clip,
    channelId: target.ch.id,
    index,
    readout: null,
  };
}

/** Starts dragging the curve handle after point `index`, from height `y`. */
export function startTensionDrag(ctx: PlaylistContext, target: AutoTarget, index: number, y: number): void {
  const from = target.ch.points[index];
  const to = target.ch.points[index + 1];
  ctx.state.drag = {
    kind: 'tension',
    gesture: ctx.s.history.gesture('Bend automation curve'),
    clip: target.clip,
    channelId: target.ch.id,
    index,
    y0: y,
    t0: from?.tension ?? 0,
    sign: from && to && to.value > from.value ? -1 : 1,
    readout: null,
  };
}

/** The point follows the pointer; the value it has now shows next to the pointer and in the hint bar. */
export function dragAutomationPoint(ctx: PlaylistContext, drag: PointDrag, x: number, y: number, event: PointerEvent): void {
  const project = ctx.s.doc.getState().project;
  const box = boxOfClip(ctx, drag.clip, project);
  if (!box) return;
  const tick = contentTickAt(ctx, drag.clip, x, project, event);
  const value = yToValue(y, box);
  drag.gesture.update((draft) => moveAutomationPoint(draft, drag.channelId, drag.index, tick, value));
  const now = ctx.s.doc.getState().project;
  const channel = automationChannelOf(drag.clip, now);
  const point = channel?.points[drag.index];
  if (!channel || !point) return;
  const text = pointText(ctx, channel, drag.clip, point.tick, point.value, now);
  drag.readout = { x, y, text };
  emitHint(ctx.els.gridHost, `${ctx.s.automation.labelOf(channel, now)}: ${text}`);
  ctx.invalidate('overlay');
}

/** The curve bends as the handle moves up or down. */
export function dragAutomationTension(ctx: PlaylistContext, drag: TensionDrag, x: number, y: number): void {
  const bend = clamp(drag.t0 + ((drag.y0 - y) / TENSION_DRAG_PX) * drag.sign, -1, 1);
  const tension = Math.abs(bend) < STRAIGHT_BEND ? 0 : bend;
  drag.gesture.update((draft) => setAutomationPointTension(draft, drag.channelId, drag.index, tension));
  const text = tension === 0 ? 'Straight' : `Bend ${Math.round(Math.abs(tension) * 100)}%`;
  drag.readout = { x, y, text };
  emitHint(ctx.els.gridHost, `Curve: ${text} · drag up or down · double-click to straighten`);
  ctx.invalidate('overlay');
}

/** Straightens the curve handle under a double-click. */
export function straightenCurve(ctx: PlaylistContext, channelId: AutomationChannel['id'], index: number): void {
  ctx.s.history.transact('Straighten curve', (draft) => setAutomationPointTension(draft, channelId, index, 0));
}

