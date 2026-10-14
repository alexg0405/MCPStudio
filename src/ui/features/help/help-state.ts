import { createStore } from 'zustand';

/** The welcome screen and the guided tour (out of Help.tsx so editing it hot-updates). */
export const helpStore = createStore<{ welcome: boolean; tour: number | null }>(() => ({ welcome: false, tour: null }));

export const showWelcome = () => helpStore.setState({ welcome: true, tour: null });
export const startTour = () => helpStore.setState({ welcome: false, tour: 0 });
