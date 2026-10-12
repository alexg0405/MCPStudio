import { createStore } from 'zustand/vanilla';

/** Stand-in transport state until the audio engine arrives in M1. */
export const stubTransport = createStore<{ playing: boolean }>(() => ({ playing: false }));
