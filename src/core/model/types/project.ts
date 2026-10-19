import type { DjMixState } from './dj';
import type { Launcher } from './launcher';
import type { ReferenceTrack } from './reference';
import type { ChannelId, ChordId, LinkId, LyricId, PatternId, SampleId, Tick } from './ids';
import type { Channel } from './channels';
import type { Pattern } from './patterns';
import type { Playlist } from './playlist';
import type { ControllerLink } from './automation';
import type { Mixer, MixSnapshot } from './mixer';
import type { SampleRef } from './samples';

/** The whole project document: what is saved (project.json) and what undo and redo operate on. */
export interface Project {
  schemaVersion: number;
  /** Stable identity across saves (autosave/recovery). */
  projectId: string;
  meta: ProjectMeta;
  transport: TransportSettings;
  channels: Record<ChannelId, Channel>;
  channelOrder: ChannelId[];
  patterns: Record<PatternId, Pattern>;
  patternOrder: PatternId[];
  playlist: Playlist;
  mixer: Mixer;
  /**
   * Saved mixer states (faders, pans, mutes, sends, effect settings) the musician can recall and compare, in the
   * order they were saved. Never touches notes or the arrangement. Absent until one is saved. Added in v3 (optional).
   */
  mixSnapshots?: MixSnapshot[];
  samples: Record<SampleId, SampleRef>;
  /** MIDI controller links ("Link to controller"), keyed by id. */
  controllers: Record<LinkId, ControllerLink>;
  /**
   * The DJ mix the auto-mix wrote into this project (absent otherwise): its songs in order, the
   * options and per-transition tweaks it was made with, and what it made (replaced when it is made
   * again). Added in v3 (optional).
   */
  dj?: DjMixState;
  /**
   * The reference track (absent when none is set): a song the musician owns, measured. Only derived
   * numbers (tempo, key, sections and energy, loudness, tonal balance, stereo width) are kept in the
   * document; its audio is never part of the song. Added in v3 (optional).
   */
  reference?: ReferenceTrack;
  /**
   * The clip launcher's grid (Performance mode): tracks × scenes of slots that point at patterns and audio
   * channels. Absent until a slot is filled. Launching is session state (`core/launcher`), never in the
   * document. Added in v3 (optional).
   */
  launcher?: Launcher;
  /**
   * The chord track: chord symbols over song time (a lane above the playlist, shown behind the piano roll), the
   * harmony basslines, chord parts and melodies are written against. Absent until a chord is added; chords never
   * overlap (`core/ops/chords.ts`). Added in v3 (optional).
   */
  chords?: Record<ChordId, ChordEvent>;
  // ---- Lyrics (the lyrics lane; `core/ops/lyrics.ts`, `core/lyrics`) ----
  /**
   * The lyrics: words and syllables placed in song time, shown on a lane above the playlist, under the notes of the
   * piano roll and the note blobs of the pitch editor, and followed like karaoke in the Lyrics window. Absent until a
   * word is added; words never overlap (`core/ops/lyrics.ts`). Added with the lyrics lane (optional, no version bump).
   */
  lyrics?: Record<LyricId, LyricWord>;
  // ---- end of lyrics ----
}

/**
 * One word or syllable of the lyrics, sung from `tick` for `length` ticks. Words of one line share `line` (a line
 * ends where the next word in time has another number); a syllable that goes on in the next word has `continues`
 * ("beau-ti-ful" is three words, the first two with `continues: true`).
 */
export interface LyricWord {
  id: LyricId;
  tick: Tick;
  length: Tick;
  /** What is sung, without hyphens or spaces (1–80 characters). */
  text: string;
  /** The line this word belongs to (a whole number, 0 or more). */
  line: number;
  /** True when the word continues in the next one (a hyphen is drawn after it, and the two read as one word). */
  continues?: true;
}

/** One chord on the chord track: held from `tick` for `length` ticks (a gap before the next one means no chord). */
export interface ChordEvent {
  id: ChordId;
  tick: Tick;
  length: Tick;
  /** Pitch class of the root, 0 (C) – 11 (B). */
  root: number;
  /** A quality id from `core/harmony/chord` ("maj", "min", "m7", "sus4", "add9"…). */
  quality: string;
  /** Pitch class of the bass for a slash chord (F/C); absent = the root. */
  bass?: number;
  /** 0–1, set when the chord was detected from notes or audio; a hand edit clears it. */
  confidence?: number;
}

/** Who made the project and with which version of the app. */
export interface ProjectMeta {
  title: string;
  author?: string;
  createdAt: string;
  appVersion: string;
}

/** Beats per bar over the note value of a beat (4/4: num 4, den 4). */
export interface TimeSignature {
  num: number;
  den: number;
}

/** Tempo, meter, swing and key of the song. */
export interface TransportSettings {
  bpm: number;
  timeSig: TimeSignature;
  /** Global swing 0–1: delays every second 1/16 step by up to half a step. */
  swing: number;
  /** The song's key (scale highlighting and snapping, the AI); absent = no key set. */
  key?: SongKey;
}

/** The song's key: a tonic and a scale. */
export interface SongKey {
  /** Pitch class of the tonic, 0 (C) – 11 (B). */
  root: number;
  /** Scale id from `@agstudio/sdk/notes` (e.g. 'major', 'minor'); unknown ids read as major. */
  scale: string;
}
