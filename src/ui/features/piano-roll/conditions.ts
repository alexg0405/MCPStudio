/** When the piano roll's commands and shortcuts apply. */
import type { Services } from '@app/services';
import { noteTarget } from './commands';

/** Piano roll shortcuts only work while the piano roll window has the focus. */
export const PIANO_ROLL_FOCUS = { focus: ['piano-roll'] as const };

/** The channel has a pattern with notes to work on. */
export const hasNotes = (s: Services): boolean => !!noteTarget(s);

/** Some notes are selected. */
export const hasSelection = (s: Services): boolean => (noteTarget(s)?.selected.length ?? 0) > 0;

/** The song has a key (scale lock and scale highlighting need one). */
export const hasSongKey = (s: Services): boolean => !!s.doc.getState().project.transport.key;
