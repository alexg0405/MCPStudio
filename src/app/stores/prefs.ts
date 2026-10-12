import { createStore, type StoreApi } from 'zustand/vanilla';

/** Per-browser preferences (localStorage). Not part of any project. */
export interface PrefsState {
  /** FL's "typing keyboard to piano": letter keys play the selected channel. */
  typingPiano: boolean;
  /** Octave of the bottom keyboard row (FL numbering: 5 → C5 = MIDI 60). */
  pianoOctave: number;
  /** Listen to connected MIDI keyboards. */
  midiInput: boolean;
}

export interface PrefsActions {
  set(patch: Partial<PrefsState>): void;
}

export type PrefsStore = StoreApi<PrefsState & PrefsActions>;

const KEY = 'agstudio:prefs:v1';
const DEFAULTS: PrefsState = { typingPiano: false, pianoOctave: 5, midiInput: false };

function load(): PrefsState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PrefsState>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function createPrefsStore(): PrefsStore {
  const store = createStore<PrefsState & PrefsActions>()((set) => ({
    ...load(),
    set: (patch) => set(patch),
  }));
  store.subscribe((s) => {
    try {
      const { typingPiano, pianoOctave, midiInput } = s;
      globalThis.localStorage?.setItem(KEY, JSON.stringify({ typingPiano, pianoOctave, midiInput }));
    } catch {
      /* storage unavailable */
    }
  });
  return store;
}
