/** What `autoLevel` takes and gives back. */
import type { Style } from '@core/beat/style';
import type { InsertId, Tick } from '@core/model/types';
import type { LeveledBus } from './targets';

export interface AutoLevelOptions {
  style: Style;
  /** The master's loudness to reach (LUFS) instead of the style's (a reference song's, say). */
  targetLufs?: number;
  /** The part to listen to (default: the busiest section, 8 bars). */
  fromTick?: Tick;
  bars?: number;
  /** Mixer tracks whose faders the AI set itself (left alone). */
  pinned?: ReadonlySet<InsertId>;
  /** Fold the edit into this undo entry while it is the newest (the AI answer's); null: its own step. */
  entry?: number | null;
  signal?: AbortSignal;
  progress?(label: string, fraction: number): void;
  /**
   * Resolves when nothing is playing. Rendering competes with playback for the CPU (it gets choppy)
   * and the new levels would jump in mid-song, so each render and the edit wait for it. Without it,
   * leveling stops playback first.
   */
  whenQuiet?(): Promise<void>;
  sampleRate?: number;
}

/** One bus before and after leveling. */
export interface BusReading {
  role: LeveledBus;
  /** Measured before leveling, and where the moves put it (LUFS). */
  before: number;
  after: number;
  /** Its style target (LUFS, relative to the kick as measured). */
  target: number;
  fromDb: number;
  toDb: number;
}

export interface AutoLevelResult {
  message: string;
  changes: string[];
  warnings: string[];
  style: Style;
  buses: BusReading[];
  /** The master as rendered after leveling. */
  master: { lufs: number; truePeakDb: number | null; target: number };
  /** The Limiter's input gain it set (dB), or null without a Limiter. */
  limiterInput: number | null;
  /** The Maximizer's input gain (dB) when the loudness needed one, else null. */
  maximizerInput: number | null;
}
