/**
 * The project as JSON text, worked out once per project version. A project is an immutable value (every edit makes a new
 * object), and the same text is wanted again and again: the reload snapshot a second after every change (view moves
 * included, and those do not touch the project), autosaves and version save points. For a project of a few hundred KB
 * each of those used to serialize it afresh.
 */
import type { Project } from '../model/types';

const texts = new WeakMap<Project, string>();

/** `JSON.stringify(project)`, remembered for this project object. Never call it on a draft that is still being edited. */
export function projectJson(project: Project): string {
  let text = texts.get(project);
  if (text === undefined) {
    text = JSON.stringify(project);
    texts.set(project, text);
  }
  return text;
}
