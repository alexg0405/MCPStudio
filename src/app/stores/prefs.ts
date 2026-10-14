import { createStore, type StoreApi } from 'zustand/vanilla';

/** Per-browser preferences (localStorage). Not part of any project. */
export interface PrefsState {
  /** FL's "typing keyboard to piano": letter keys play the selected channel. */
  typingPiano: boolean;
  /** Octave of the bottom keyboard row (FL numbering: 5 → C5 = MIDI 60). */
  pianoOctave: number;
  /** Listen to connected MIDI keyboards. */
  midiInput: boolean;
  /** Last export settings: WAV bit depth, sample rate… */
  exportFormat: 'pcm16' | 'pcm24' | 'float32';
  exportSampleRate: number;
  /** …file format, FLAC bit depth, MP3 bit rate (kbps)… */
  exportCodec: 'wav' | 'flac' | 'mp3';
  exportFlacBits: number;
  exportMp3Kbps: number;
  /** …normalize to −0.3 dBFS, stems, stems through the master chain, stems into a folder or a .zip. */
  exportNormalize: boolean;
  exportStems: boolean;
  exportMasterChain: boolean;
  exportStemsTo: 'folder' | 'zip';
  /** Metronome clicks while playing. */
  metronome: boolean;
  /** Bars of count-in when recording (0 = none). */
  countInBars: number;
  /** Grid recorded note starts snap to (ticks; 0 = as played). */
  recordQuantize: number;
  /** Recording over existing notes adds to them or replaces what it passes over. */
  recordMode: 'overdub' | 'replace';
  /** Hover a control for a moment to see what it does (the hint bar shows it either way). */
  tooltips: boolean;
  /** The welcome dialog was closed once; it no longer opens by itself. */
  welcomeSeen: boolean;
  /** Most recent first: what the action search ranks higher. */
  recentActions: string[];
}

export interface PrefsActions {
  set(patch: Partial<PrefsState>): void;
}

export type PrefsStore = StoreApi<PrefsState & PrefsActions>;

const KEY = 'agstudio:prefs:v1';
const DEFAULTS: PrefsState = {
  typingPiano: false,
  pianoOctave: 5,
  midiInput: false,
  exportFormat: 'pcm24',
  exportSampleRate: 48000,
  exportCodec: 'wav',
  exportFlacBits: 24,
  exportMp3Kbps: 320,
  exportNormalize: false,
  exportStems: false,
  exportMasterChain: true,
  exportStemsTo: 'folder',
  metronome: false,
  countInBars: 1,
  recordQuantize: 0,
  recordMode: 'overdub',
  tooltips: true,
  welcomeSeen: false,
  recentActions: [],
};

function load(): PrefsState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    // Known keys with the right type only: a stale or hand-edited entry falls back to its default.
    const out: Record<string, unknown> = { ...DEFAULTS };
    for (const [k, v] of Object.entries(DEFAULTS)) {
      const got = saved[k];
      if (got !== undefined && typeof got === typeof v && Array.isArray(got) === Array.isArray(v)) out[k] = got;
    }
    return out as unknown as PrefsState;
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
      const saved = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, s[k as keyof PrefsState]]));
      globalThis.localStorage?.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* storage unavailable */
    }
  });
  return store;
}
