import { createStore } from 'zustand';

/** The welcome screen (out of Help.tsx so editing it hot-updates). */
export const helpStore = createStore<{ welcome: boolean }>(() => ({ welcome: false }));

export const showWelcome = () => helpStore.setState({ welcome: true });
