import type { Style } from '../style';

/** What a performed sound became on the grid (structurally a voice-analysis GridEvent). */
export interface PerformedEvent {
  step: number;
  lengthSteps: number;
  kind: 'kick' | 'snare' | 'hat' | 'tonal';
  strength: number;
  pitch: number | null;
  pitchEnd: number | null;
}

/** What the user's noises stand for. */
export type PerformanceRole = 'auto' | 'drums' | '808' | 'melody';

/** What the offline generator read out of a request. */
export interface PromptInfo {
  bpm?: number;
  style?: Style;
  /** Pitch class 0–11 of the key's root and whether it's minor. */
  key?: { root: number; minor: boolean };
  /** −1 simpler … +1 busier. */
  density: number;
  wants808: boolean;
  wantsMelody: boolean;
  /** Mentions of drum parts the user wants ('only drums', 'no hats' are handled too). */
  noHats: boolean;
  drumsOnly: boolean;
}

/** A request for the offline generator. */
export interface LocalBeatInput {
  prompt: string;
  /** The project's tempo (used unless the prompt names one). */
  bpm: number;
  performance?: { events: readonly PerformedEvent[]; role: PerformanceRole; bars: number };
}
