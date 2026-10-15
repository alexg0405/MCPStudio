/**
 * Track analyses by content hash: computed in a Worker the first time a song is looked at, stored so
 * it is never computed twice (survives reloads), and shared by the library, the auto-mix and the decks.
 * (The analysis itself lives in core/dj; this is the cache and the entry point the UI and actions call.)
 */
import type { SampleRef } from '@core/model/types';
import type { TrackAnalysis } from '@core/dj/types';
import type { Services } from '../services';

export interface AnalysisProgress {
  hash: string;
  /** 0–1 */
  fraction: number;
}

export interface TrackAnalyzer {
  /** The cached analysis, or null (not analyzed yet). */
  peek(hash: string): TrackAnalysis | null;
  /** The analysis: cached, or computed now (the file is decoded and analyzed off the main thread). */
  analyze(s: Services, ref: SampleRef, opts?: { signal?: AbortSignal; onProgress?(p: AnalysisProgress): void }): Promise<TrackAnalysis>;
  /** Called when any analysis is added (the library redraws). */
  subscribe(fn: () => void): () => void;
}
