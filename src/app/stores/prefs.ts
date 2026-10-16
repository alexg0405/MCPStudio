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
  /** What record mode records: notes and knob moves, and/or audio from the input. */
  recordNotes: boolean;
  recordAudio: boolean;
  /** The audio input ('' = the system default), mono or stereo. */
  audioInputDevice: string;
  audioInputChannels: 'mono' | 'stereo';
  /** Hear the input through a mixer track while recording (off: speakers would feed back into the mic). */
  audioMonitor: boolean;
  /** Mixer track the input is monitored through and recorded audio plays on ('' = Master). */
  audioInputTrack: string;
  /** Measured round-trip latency in ms (−1: use the browser's estimate), and a manual correction. */
  recordLatencyMs: number;
  recordLatencyOffsetMs: number;
  /** Hover a control for a moment to see what it does (the hint bar shows it either way). */
  tooltips: boolean;
  /** The welcome dialog was closed once; it no longer opens by itself. */
  welcomeSeen: boolean;
  /** Most recent first: what the action search ranks higher. */
  recentActions: string[];
  /** Your own keyboard shortcuts by command id (they replace its built-in ones; [] = none). */
  customKeys: Record<string, string[]>;
  /** The audio output device ('' = the system default). */
  outputDevice: string;
  /**
   * How much audio the browser prepares ahead: 'large' plays smoothest with busy songs, 'small' answers
   * fastest when you play live (but crackles sooner).
   */
  audioBuffer: AudioBufferSize;
  /** Megabytes of decoded audio kept in memory (long songs beyond it are decoded around the playhead). */
  sampleMemoryMb: number;
  /** The little display in the toolbar: the waveform or spectrum of what you hear, or hidden. */
  scopeMode: 'scope' | 'spectrum' | 'off';
  /** While playing, the playlist and piano roll scroll to keep the playhead in view (FL's auto-scroll). */
  followPlayhead: boolean;
  /** The look: theme (marble, carrara, classic, midnight, graphite, light) and accent color (gold, orange…). */
  theme: string;
  accent: string;
  /** Whether the user chose the accent. Gold is also the untouched default, so only a picked gold shows as gold on the slate themes. */
  accentPicked: boolean;
}

export type AudioBufferSize = 'small' | 'medium' | 'large';

/** The browser's latency hint for each buffer size (about 5, 10 and 21 ms in Chrome). */
export const AUDIO_BUFFER_HINT: Record<AudioBufferSize, AudioContextLatencyCategory> = {
  small: 'interactive',
  medium: 'balanced',
  large: 'playback',
};

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
  recordNotes: true,
  recordAudio: false,
  audioInputDevice: '',
  audioInputChannels: 'mono',
  audioMonitor: false,
  audioInputTrack: '',
  recordLatencyMs: -1,
  recordLatencyOffsetMs: 0,
  tooltips: true,
  welcomeSeen: false,
  recentActions: [],
  customKeys: {},
  outputDevice: '',
  audioBuffer: 'large',
  sampleMemoryMb: 1536,
  scopeMode: 'scope',
  followPlayhead: true,
  theme: 'marble',
  accent: 'gold',
  accentPicked: false,
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
    // The old default look (slate 'dark' with orange) was never a choice: it becomes the new default.
    if (out.theme === 'dark' && (out.accent === 'orange' || saved.accent === undefined)) {
      out.theme = 'marble';
      out.accent = 'gold';
    }
    if (!Object.hasOwn(AUDIO_BUFFER_HINT, out.audioBuffer as string)) out.audioBuffer = DEFAULTS.audioBuffer;
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
