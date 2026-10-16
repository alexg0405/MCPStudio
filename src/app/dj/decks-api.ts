/**
 * The contract between DJ live decks and whatever drives them: the Decks window, MIDI DJ controllers
 * (app/dj/controllers), the Studio and the keyboard all go through `DecksApi`. Deck state is live
 * performance state, not part of the project: nothing here goes through History. (Recording the
 * master makes a new audio clip in the project, which is an ordinary undoable edit.)
 *
 * Units: seconds of the song file, BPM, pitch as a fraction (+0.08 = 8 % faster), EQ in dB,
 * filter −1…1 (below 0 a low-pass closes, above 0 a high-pass opens, 0 = off), crossfader −1 (A)…+1 (B).
 */
import type { StoreApi } from 'zustand/vanilla';
import type { SampleRef } from '@core/model/types';
import type { DeckWaveform } from '@core/dj/deck-peaks';
import type { TrackAnalysis } from '@core/dj/types';
import type { CrossfaderCurve } from '@core/dj/decks-math';

export type { DeckWaveform };

export type DeckId = 'A' | 'B' | 'C' | 'D';
export const DECK_IDS: readonly DeckId[] = ['A', 'B', 'C', 'D'];
export type EqBand = 'low' | 'mid' | 'high';
export const HOT_CUES = 8;

export interface DeckLoop {
  startSec: number;
  endSec: number;
  active: boolean;
}

export interface DeckState {
  id: DeckId;
  /** The loaded song (a library song's sample), or null. */
  song: { ref: SampleRef; title: string; artist?: string; durationSec: number } | null;
  /** Loading or analyzing the song. */
  loading: boolean;
  playing: boolean;
  /** Where the deck is in the song file (seconds), as of `positionAt` (performance.now() ms). */
  positionSec: number;
  positionAt: number;
  /** The song's own tempo (from analysis), and the tempo it plays at now (base × (1 + pitch)). */
  baseBpm: number | null;
  bpm: number | null;
  /** −0.5…+0.5; the pitch fader range is set by `pitchRange` (0.08, 0.16 or 0.5). */
  pitch: number;
  pitchRange: 0.08 | 0.16 | 0.5;
  /** Keep the key when the tempo moves (time-stretch) instead of bending it like a turntable. */
  keyLock: boolean;
  /** Following another deck's tempo and beat phase. */
  synced: boolean;
  /** Channel fader 0…1.25 (1 = 0 dB), trim in dB. */
  volume: number;
  trimDb: number;
  eq: Record<EqBand, number>;
  filter: number;
  /** Heard on the cue (headphone) bus. */
  cueListen: boolean;
  /** The main cue point (seconds), and hot cues 1–8 (null = unset). */
  cuePoint: number;
  hotCues: (number | null)[];
  loop: DeckLoop | null;
  /** Beats per jump and per auto loop. */
  beatJump: number;
  /** Level on the deck's meter (0…1, peak), updated a few times a second. */
  level: number;
}

export interface DecksState {
  decks: Record<DeckId, DeckState>;
  /** How many decks are shown (2 or 4). */
  deckCount: 2 | 4;
  crossfader: number;
  /** Which decks sit on each side of the crossfader (C and D can be thru: not affected). */
  crossfaderAssign: Record<DeckId, 'A' | 'B' | 'thru'>;
  crossfaderCurve: 'smooth' | 'sharp';
  masterVolume: number;
  /** Recording the master output (null when not recording). */
  recording: { startedAt: number } | null;
}

export interface DecksApi {
  readonly store: StoreApi<DecksState>;

  /** Loads a library song (or any audio sample) on a deck; analysis is fetched or computed. */
  load(deck: DeckId, ref: SampleRef, title: string, artist?: string): Promise<void>;
  eject(deck: DeckId): void;

  play(deck: DeckId): void;
  pause(deck: DeckId): void;
  togglePlay(deck: DeckId): void;
  /** CDJ-style cue: paused, sets the cue point here (snapped to a beat); playing, returns to it and pauses; held, previews. */
  cueDown(deck: DeckId): void;
  cueUp(deck: DeckId): void;
  seek(deck: DeckId, sec: number): void;
  /** Jog wheel: `delta` in revolutions-ish units; touching the platter while playing scratches, the rim nudges. */
  jog(deck: DeckId, delta: number, mode: 'nudge' | 'scratch'): void;
  jogTouch(deck: DeckId, touching: boolean): void;

  setPitch(deck: DeckId, pitch: number): void;
  setPitchRange(deck: DeckId, range: DeckState['pitchRange']): void;
  setKeyLock(deck: DeckId, on: boolean): void;
  /** Match this deck's tempo and beat phase to the other playing deck (the master); toggle off with false. */
  sync(deck: DeckId, on?: boolean): void;

  setVolume(deck: DeckId, v: number): void;
  setTrim(deck: DeckId, db: number): void;
  setEq(deck: DeckId, band: EqBand, db: number): void;
  setFilter(deck: DeckId, v: number): void;
  setCueListen(deck: DeckId, on: boolean): void;
  setCrossfader(v: number): void;
  setCrossfaderAssign(deck: DeckId, side: 'A' | 'B' | 'thru'): void;
  setMasterVolume(v: number): void;

  /** Hot cue i (0-based): set when empty, jump (and play) when set. `clearHotCue` removes it. */
  hotCue(deck: DeckId, i: number): void;
  clearHotCue(deck: DeckId, i: number): void;
  /** Loops on the beat grid: in/out by hand, or an auto loop of `beats` from here; halve/double; exit. */
  loopIn(deck: DeckId): void;
  loopOut(deck: DeckId): void;
  autoLoop(deck: DeckId, beats: number): void;
  loopHalve(deck: DeckId): void;
  loopDouble(deck: DeckId): void;
  exitLoop(deck: DeckId): void;
  /** Jumps `beats` forward (negative: back), keeping the phase. */
  beatJumpBy(deck: DeckId, beats: number): void;

  /** Records the master output; stopping puts the recording in the music library and returns its title. */
  startRecording(): Promise<void>;
  stopRecording(): Promise<string | null>;

  /** Where a deck is right now (extrapolated while playing): for waveforms and the platter, called per frame. */
  positionNow(deck: DeckId): number;
  /** Stops everything and frees the decks' audio graph. */
  dispose(): void;

  // ---- Optional additions (the Decks window and the Studio use these; a controller can ignore them) ----

  /** The crossfader curve (smooth = equal power, sharp = cut). */
  setCrossfaderCurve?(curve: CrossfaderCurve): void;
  /** Shows 2 or 4 decks. */
  setDeckCount?(count: 2 | 4): void;
  /** Glides the crossfader to `to` (−1…1) over `beats` beats of the tempo playing (a fade, not a jump). */
  crossfade?(to: number, beats: number): void;
  /** Peak levels of decks A–D into out[0…3] and the master (left, right) into out[4], out[5]: allocation-free, for requestAnimationFrame. */
  readLevels?(out: Float32Array): void;
  /** The song's peak overview (null until it is computed). */
  waveformOf?(deck: DeckId): DeckWaveform | null;
  /** The loaded song's analysis (beat grid, key), or null. */
  analysisOf?(deck: DeckId): TrackAnalysis | null;
  /** Plays the cue (headphone) bus through this output device ('' = none); false where the browser can't. */
  setCueDevice?(deviceId: string): Promise<boolean>;
  /** Resolves once the audio thread has handled every command sent so far (offline renders and tests). */
  settled?(): Promise<void>;
  /** How fast the decks' audio kept up over the last second (1 = fully; absent while nothing plays). */
  keepUp?(): number | undefined;
}

/** Created on first use (the Decks window, a controller, the Studio), not at startup. */
export type DecksFactory = () => Promise<DecksApi>;
