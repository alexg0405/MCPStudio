import { createStore } from 'zustand';

/**
 * Whether the filter chooser (Playlist › Apply a filter…) is open, and the filter to start on. Kept
 * out of the component file so editing the dialog hot-updates instead of reloading the page.
 */
export const filterStore = createStore<{ open: { filter?: string } | null }>(() => ({ open: null }));
