/** Whether the project has a song to change, kept apart from the interpreter so the app can ask without loading it. */
import type { Project } from '../model/types';

/** Whether the project has a song on its playlist that an edit can change. */
export function hasSongToEdit(project: Project): boolean {
  return Object.values(project.playlist.clips).some((clip) => clip.kind === 'pattern');
}
