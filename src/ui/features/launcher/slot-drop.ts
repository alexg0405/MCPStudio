/** What can be dropped on a launcher slot: a pattern, another slot (move, or copy with Alt) or audio files. */
import type { DragEvent } from 'react';
import type { Services } from '@app/services';
import { putAudioFilesAt, putInSlotAt } from '@app/launcher/edit';
import type { LaunchTrackId, PatternId, SceneId } from '@core/model/types';
import { moveSlot } from '@core/ops/launcher';
import { dragMayHaveAudio, takeAudioFiles } from '../../audio-drag';

/** The drag data type a Browser pattern carries. */
const PATTERN_DRAG = 'application/x-agstudio-pattern';
/** The drag data type a slot's grip carries: JSON `{ t: trackId, s: sceneId }` of the slot being moved. */
export const SLOT_DRAG = 'application/x-agstudio-launch-slot';

/** Where on the grid a drop happened; the ids are missing for cells beyond the real tracks and scenes. */
export interface SlotPlace {
  trackIndex: number;
  sceneIndex: number;
  trackId: LaunchTrackId | undefined;
  sceneId: SceneId | undefined;
}

/** True when something droppable is being dragged over a slot (so the slot lights up and accepts the drop). */
export function canDropOnSlot(dataTransfer: DataTransfer): boolean {
  const types = dataTransfer.types;
  return types.includes(PATTERN_DRAG) || types.includes(SLOT_DRAG) || dragMayHaveAudio(dataTransfer);
}

/** The drop effect to show: moving a slot, unless Alt is held (then it copies). Everything else copies. */
export function slotDropEffect(dataTransfer: DataTransfer, isAltHeld: boolean): 'move' | 'copy' {
  return dataTransfer.types.includes(SLOT_DRAG) && !isAltHeld ? 'move' : 'copy';
}

/** The slot's grip starts a drag of that slot. */
export function startSlotDrag(e: DragEvent, trackId: LaunchTrackId, sceneId: SceneId): void {
  e.dataTransfer.setData(SLOT_DRAG, JSON.stringify({ t: trackId, s: sceneId }));
  e.dataTransfer.effectAllowed = 'copyMove';
}

/** Audio files dropped from the computer or the sample browser: imported and put in the slot, with a toast. */
function dropAudioFiles(services: Services, e: DragEvent, place: SlotPlace): void {
  // Read now: the drop's data is gone afterwards.
  const files = takeAudioFiles(e.dataTransfer);
  if (!files) return;
  e.preventDefault();
  void putAudioFilesAt(services, files, place.trackIndex, place.sceneIndex).then((count) => {
    if (!count) return;
    const noun = count === 1 ? 'file' : 'files';
    services.session.getState().toast(`Put ${count} audio ${noun} in the launcher. Undo takes ${count === 1 ? 'it' : 'them'} back.`);
  });
}

/** Another slot dropped here: move it, or copy it with Alt held. */
function dropSlot(services: Services, e: DragEvent, movedData: string, place: SlotPlace): void {
  try {
    const from = JSON.parse(movedData) as { t: LaunchTrackId; s: SceneId };
    const { trackId, sceneId } = place;
    if (!trackId || !sceneId) return;
    const label = e.altKey ? 'Copy launcher slot' : 'Move launcher slot';
    services.history.transact(label, (d) => void moveSlot(d, { trackId: from.t, sceneId: from.s }, { trackId, sceneId }, e.altKey));
  } catch {
    /* not ours */
  }
}

/** Handles a drop on a slot: a pattern, another slot, or audio files. Anything else is left to the browser. */
export function dropOnSlot(services: Services, e: DragEvent, place: SlotPlace): void {
  const pattern = e.dataTransfer.getData(PATTERN_DRAG);
  const movedSlot = e.dataTransfer.getData(SLOT_DRAG);
  if (!pattern && !movedSlot) {
    dropAudioFiles(services, e, place);
    return;
  }
  e.preventDefault();
  if (pattern) {
    const problem = putInSlotAt(services, place.trackIndex, place.sceneIndex, { kind: 'pattern', patternId: pattern as PatternId });
    if (problem) services.session.getState().toast(problem, 'error');
    return;
  }
  dropSlot(services, e, movedSlot, place);
}
