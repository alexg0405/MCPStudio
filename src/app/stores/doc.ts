import { createStore, type StoreApi } from 'zustand/vanilla';
import { History } from '@core/history/history';
import type { Project } from '@core/model/types';

/**
 * The project document for React (narrow selectors via useDoc). All writes go through `history`,
 * never through setState: that is what keeps every change undoable.
 */
export type DocStore = StoreApi<{ project: Project }>;

export function createDoc(initial: Project): { store: DocStore; history: History } {
  const store = createStore<{ project: Project }>()(() => ({ project: initial }));
  const history = new History({
    get: () => store.getState().project,
    set: (project) => store.setState({ project }),
  });
  return { store, history };
}
