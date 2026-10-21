/**
 * Answers the project text needs more than once while it is being written, kept per project version. The text is
 * built up to seven times (each pass shortens one more part) and again on every turn, but the document is immutable:
 * the same project object always gives the same answer, so the slow parts (reading the arrangement, checking the song,
 * grouping clips into runs) are worked out once for it. A new project version starts with nothing cached.
 */
import type { Project } from '@core/model/types';

const caches = new WeakMap<Project, Map<string, unknown>>();

/**
 * What `compute` gives for `project`, worked out the first time and remembered for as long as that project version
 * lives. `key` names the question. Only for functions of the project alone (no view, selection or render settings).
 */
export function cachedForProject<T>(project: Project, key: string, compute: () => T): T {
  let answers = caches.get(project);
  if (!answers) {
    answers = new Map();
    caches.set(project, answers);
  }
  if (answers.has(key)) return answers.get(key) as T;
  const answer = compute();
  answers.set(key, answer);
  return answer;
}
