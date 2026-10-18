/** Double-clicks on the grid: open the pitch editor, reset a handle, straighten or add on an automation curve, open a pattern. */
import type { Project } from '@core/model/types';
import { audioHandleAt, resetLevel } from './audio-handles';
import { addAutomationPointAt, automationTargetAt, straightenCurve } from './automation-edit';
import type { Hit, PlaylistContext } from './context';
import { hitTest, localPoint } from './hit-test';
import { currentProject } from './lanes';

/** A double-click at the pointer. */
export function onDoubleClick(ctx: PlaylistContext, event: MouseEvent): void {
  const project = currentProject(ctx);
  const { x, y } = localPoint(ctx, event);
  const hit = hitTest(ctx, x, y, project);
  // Alt + double-click an audio clip: the Pitch editor.
  if (event.altKey && hit?.clip.kind === 'audio') {
    ctx.s.editor.getState().selectClips([hit.clip.id]);
    void ctx.s.commands.run('pitchEditor.openClip', { clip: hit.clip.id });
    return;
  }
  // Double-click a handle: back to 0 dB, or no fade.
  const handle = hit ? audioHandleAt(ctx, hit, x, y, project) : null;
  if (hit?.clip.kind === 'audio' && handle) {
    resetLevel(ctx, hit.clip.id, handle);
    return;
  }
  if (doubleClickOnAutomation(ctx, hit, x, y, event, project)) return;
  if (hit?.clip.kind === 'pattern') {
    // FL: double-clicking a pattern clip opens that pattern.
    ctx.s.view.getState().setCurrentPattern(hit.clip.patternId);
    ctx.s.view.getState().showWindow('channel-rack', 'channel-rack');
  }
}

/** Double-click on an automation clip: straighten a curve handle, or add a point on the curve. Returns true when it was on one. */
function doubleClickOnAutomation(
  ctx: PlaylistContext,
  hit: Hit | null,
  x: number,
  y: number,
  event: MouseEvent,
  project: Project,
): boolean {
  const target = automationTargetAt(ctx, hit, x, y, project);
  if (!target) return false;
  if (target.hit.part === 'handle') straightenCurve(ctx, target.ch.id, target.hit.index);
  else if (target.hit.part === 'curve') addAutomationPointAt(ctx, target, x, y, project, event);
  return true;
}
