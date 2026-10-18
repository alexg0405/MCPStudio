/**
 * The edits leveling makes to the project: the faders (what differs between the two flows) together with the
 * master's loudness stage, as one undo step that later corrections join.
 */
import type { Draft } from 'immer';
import type { Project, SlotId } from '@core/model/types';
import type { Services } from '../../services';
import { applyLoudness, tameMasterClipper, type LoudnessState } from './loudness-stage';
import type { AutoLevelOptions } from './types';

/** Called once per edit; returns what that edit does to the faders inside the draft. */
export type FaderEdit = () => (draft: Draft<Project>) => void;

/** Makes the edits of one leveling. */
export interface LoudnessEditor {
  /** Waits for the music to stop, then writes the faders and `state` into the project. */
  apply(state: LoudnessState): Promise<void>;
  /** What the first edit changed about a hard clipper on the master (empty when there was none). */
  readonly tamedClipper: string[];
  /** Plugins the edits added to the master (the Maximizer), by label. */
  readonly addedPlugins: string[];
}

/**
 * Makes the editor for one leveling. The first edit is the answer's undo step (amended into `options.entry`), or one of its
 * own; the corrections after it join that step. Another project opened meanwhile stops the edit (`projectId` is the one that
 * was listened to).
 */
export function createLoudnessEditor(
  services: Services,
  options: AutoLevelOptions,
  projectId: string,
  limiterSlotId: SlotId | undefined,
  faderEdit: FaderEdit,
): LoudnessEditor {
  let undoEntry = options.entry ?? null;
  const tamedClipper: string[] = [];
  const addedPlugins: string[] = [];

  function commit(state: LoudnessState): void {
    if (services.doc.getState().project.projectId !== projectId) {
      throw new Error('Another project was opened while leveling, so nothing was changed.');
    }
    const editFaders = faderEdit();
    services.history.transact(
      'Level the mix',
      (draft) => {
        if (!tamedClipper.length) tamedClipper.push(...tameMasterClipper(draft));
        editFaders(draft);
        for (const label of applyLoudness(draft, services, limiterSlotId, state)) {
          if (!addedPlugins.includes(label)) addedPlugins.push(label);
        }
      },
      undoEntry !== null ? { amend: undoEntry } : {},
    );
    if (undoEntry === null) undoEntry = services.history.status().cursor;
  }

  async function apply(state: LoudnessState): Promise<void> {
    await options.whenQuiet?.();
    options.signal?.throwIfAborted();
    commit(state);
  }

  return { apply, tamedClipper, addedPlugins };
}
