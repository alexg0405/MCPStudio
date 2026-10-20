/**
 * Automation points from the keyboard cursor: when the cursor is on an automation clip, Insert adds a point in its cell
 * (on the curve as it is there), Alt + Shift + Up and Down raise and lower the point in the cell, and Delete removes it.
 * Each is one undo step, and each returns the sentence a screen reader should say about the result.
 */
import { curveAt } from '@core/automation/curve';
import type { AutomationClip, Project } from '@core/model/types';
import { addAutomationPoint, moveAutomationPoint, removeAutomationPoint } from '@core/ops/automation';
import { clamp } from '../../../timeline/viewport';
import { tickToContent } from '../automation';
import { automationChannelOf } from './automation-edit';
import type { PlaylistContext } from './context';
import { automationPointInCell, pointText } from './key-cursor';

/** Alt + Shift + Up or Down changes a point's value by this much (of its whole range). */
const VALUE_STEP = 0.05;
/** The value of a point added on a curve with nothing before it (the middle of the range). */
const DEFAULT_VALUE = 0.5;

const NO_POINT = 'No automation point in this cell. Press Insert to add one.';

/** Adds a point in the cursor's cell, on the curve as it is there, and selects the clip. */
export function addPointAtCursor(ctx: PlaylistContext, clip: AutomationClip, project: Project): string {
  const channel = automationChannelOf(clip, project);
  if (!channel) return 'This automation clip drives nothing, so it has no points to add.';
  if (automationPointInCell(ctx, clip, project) >= 0) return 'There is already a point in this cell.';
  const tick = clamp(tickToContent(clip, ctx.state.keyboard.cursor.tick), clip.offset, clip.offset + clip.length);
  const value = curveAt(channel.points, tick) ?? DEFAULT_VALUE;
  let index = -1;
  ctx.s.history.transact('Add automation point', (draft) => {
    index = addAutomationPoint(draft, channel.id, { tick, value });
  });
  ctx.s.editor.getState().selectClips([clip.id]);
  const after = ctx.s.doc.getState().project;
  return `Added ${pointText(ctx, clip, index, after)}`;
}

/** Raises or lowers the point in the cursor's cell by a step of its range. */
export function adjustPointAtCursor(ctx: PlaylistContext, clip: AutomationClip, direction: -1 | 1, project: Project): string {
  const channel = automationChannelOf(clip, project);
  const index = automationPointInCell(ctx, clip, project);
  const point = channel?.points[index];
  if (!channel || !point) return NO_POINT;
  const value = clamp(point.value + direction * VALUE_STEP, 0, 1);
  if (value === point.value) return direction > 0 ? 'Already at the highest value.' : 'Already at the lowest value.';
  ctx.s.history.transact(
    'Move automation point',
    (draft) => moveAutomationPoint(draft, channel.id, index, point.tick, value),
    { mergeKey: `keyboard-point:${channel.id}:${index}` },
  );
  return `${pointText(ctx, clip, index, ctx.s.doc.getState().project)}`;
}

/** Removes the point in the cursor's cell (a curve keeps at least one point). */
export function removePointAtCursor(ctx: PlaylistContext, clip: AutomationClip, project: Project): string {
  const channel = automationChannelOf(clip, project);
  const index = automationPointInCell(ctx, clip, project);
  if (!channel || index < 0) return NO_POINT;
  if (channel.points.length <= 1) return 'A curve keeps at least one point.';
  ctx.s.history.transact('Delete automation point', (draft) => removeAutomationPoint(draft, channel.id, index));
  return `Deleted point ${index + 1}`;
}
