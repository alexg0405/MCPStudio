import { createStore } from 'zustand';

/**
 * Whether the export dialog is open (File > Export audio / Export stems). Kept out of the component
 * file so editing the dialog hot-updates instead of reloading the page.
 */
export const exportStore = createStore<{ open: boolean }>(() => ({ open: false }));
