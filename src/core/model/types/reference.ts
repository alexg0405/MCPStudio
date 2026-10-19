import type { SampleId } from './ids';

/** The measurements of a reference song (see `core/reference`). */
export interface ReferenceTrack {
  /**
   * The file as a sample of the project (for the title and for analyzing it again). It is kept out of the
   * song: no channel or clip plays it. Absent when the sample is gone.
   */
  sampleId?: SampleId;
  /** "Artist – Title" or the file name. */
  title: string;
  /** Content hash of the file. */
  hash: string;
  durationSec: number;
  /** Tempo in BPM (null: no steady beat found) and beats per bar. */
  bpm: number | null;
  beatsPerBar: number;
  /** Key (null: none found) with Camelot code and how sure the analysis is, 0–1. */
  key: { root: number; mode: 'major' | 'minor'; camelot: string; confidence: number } | null;
  /** Integrated loudness (LUFS) and true peak (dBTP) of the whole song. */
  lufs: number;
  truePeakDb: number;
  /** Tonal balance of the whole song: each band's share of the energy in dB under the total (`core/reference/bands.ts`). */
  bands: number[];
  /** Stereo width: side energy over mid energy (0 = mono). */
  width: number;
  /** Energy 0–1 per bar of the reference's own grid (per 2 s without a grid), at most 1024 values. */
  energy: number[];
  sections: ReferenceSection[];
  /** The analysis code's version when measured (older ones are measured again when the song is looked at). */
  version: number;
}

/** One part of the reference song (intro, drop, break…) with its length and energy. */
export interface ReferenceSection {
  kind: 'intro' | 'build' | 'drop' | 'break' | 'verse' | 'outro' | 'body';
  /** Seconds in the reference's file. */
  startSec: number;
  endSec: number;
  /** Length in bars of the reference's own grid (a bar of its tempo; 2 s without a grid). */
  bars: number;
  /** 0–1 relative energy within the song. */
  energy: number;
  /** Tonal balance (as `ReferenceTrack.bands`) and stereo width of this section. */
  bands: number[];
  width: number;
}
