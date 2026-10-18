/** Things dragged onto the grid from the browser: sounds, patterns and audio files. */
import type { PatternId } from '@core/model/types';
import { snapFloor } from '@core/time/snap';
import { dragMayHaveAudio, takeAudioFiles } from '../../../audio-drag';
import type { PlaylistContext } from './context';
import { localPoint } from './hit-test';
import { currentProject, laneAtY, snapTicks } from './lanes';
import { dropPattern } from './pattern-draw';

const SOUND_TYPE = 'application/x-agstudio-sound';
const PATTERN_TYPE = 'application/x-agstudio-pattern';

/** While something is dragged over the grid: say it can be dropped here when it is a sound, a pattern or audio. */
export function onDragOver(event: DragEvent): void {
  const data = event.dataTransfer;
  if (!data) return;
  if (data.types.includes(SOUND_TYPE) || data.types.includes(PATTERN_TYPE) || dragMayHaveAudio(data)) {
    event.preventDefault();
    data.dropEffect = 'copy';
  }
}

/** Dropped on the grid: at the track and the grid step under the pointer. */
export function onDrop(ctx: PlaylistContext, event: DragEvent): void {
  const data = event.dataTransfer;
  const generator = data?.getData(SOUND_TYPE);
  const patternId = data?.getData(PATTERN_TYPE);
  // Must be read during the event: the DataTransfer is emptied afterwards.
  const files = !generator && !patternId && data ? takeAudioFiles(data) : null;
  if (!generator && !patternId && !files) return;
  event.preventDefault();
  const project = currentProject(ctx);
  const { x, y } = localPoint(ctx, event);
  const lane = laneAtY(ctx, y, project);
  if (!lane) return;
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), snapTicks(ctx, project)));
  if (files) ctx.hooks.onFilesDrop?.(files, lane, tick);
  else if (generator) ctx.hooks.onSampleDrop?.(generator, lane, tick);
  else if (patternId) dropPattern(ctx, patternId as PatternId, lane, tick, project);
}
