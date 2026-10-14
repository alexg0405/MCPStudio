import { createStore } from 'zustand';
import type { Services } from '@app/services';
import { LESSONS } from './lessons';

/** The lesson in progress: which one, which step, and whether that step was just done. */
export const lessonStore = createStore<{ id: string | null; step: number; passed: boolean }>(() => ({
  id: null,
  step: 0,
  passed: false,
}));

/** Starts a lesson (its own setup first, e.g. a fresh project). */
export async function startLesson(s: Services, id: string): Promise<void> {
  const lesson = LESSONS.find((l) => l.id === id);
  if (!lesson) {
    s.session.getState().toast(`There is no lesson called “${id}”.`, 'error');
    return;
  }
  if (lesson.start && !(await lesson.start(s))) return;
  lessonStore.setState({ id, step: 0, passed: false });
}

export function stopLesson(): void {
  lessonStore.setState({ id: null, step: 0, passed: false });
}
