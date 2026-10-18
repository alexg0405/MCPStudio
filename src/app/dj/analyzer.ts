/**
 * Where DJ mode gets its track analyzer: one set with `setTrackAnalyzer` (tests, demos), else the
 * app's `services.trackAnalyzer`. Everything in DJ mode asks through here.
 */
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import type { Services } from '../services';
import type { TrackAnalyzer } from './analysis-cache';

let override: TrackAnalyzer | null = null;

/** Sets (or with null clears) an analyzer used instead of the app's. */
export function setTrackAnalyzer(a: TrackAnalyzer | null): void {
  override = a;
}

/** The analyzer in use: the one set for tests and demos, else the app's (null when there is none). */
export function trackAnalyzer(s: Services): TrackAnalyzer | null {
  return override ?? (s as Partial<Pick<Services, 'trackAnalyzer'>>).trackAnalyzer ?? null;
}

/** The content hash a sample's analysis is cached under (null for generated sounds). */
export const sampleHash = (ref: SampleRef): string | null => (ref.source.kind === 'embedded' ? ref.source.hash : null);

/** The cached analysis of a sample, or null. */
export function peekAnalysis(s: Services, ref: SampleRef): TrackAnalysis | null {
  const hash = sampleHash(ref);
  const a = trackAnalyzer(s);
  return hash && a ? a.peek(hash) : null;
}

/** A fake analyzer from hand-made analyses by hash (tests): `analyze` resolves at once. */
export function fakeAnalyzer(byHash: Map<string, TrackAnalysis>): TrackAnalyzer & { calls: number } {
  const subs = new Set<() => void>();
  const known = new Map<string, TrackAnalysis>();
  const self = {
    calls: 0,
    peek: (hash: string) => known.get(hash) ?? null,
    async analyze(_s: Services, ref: SampleRef, opts?: { onProgress?(p: { hash: string; fraction: number }): void }) {
      self.calls++;
      const hash = sampleHash(ref) ?? '';
      const a = byHash.get(hash);
      if (!a) throw new Error(`No analysis for ${ref.name}`);
      opts?.onProgress?.({ hash, fraction: 1 });
      known.set(hash, a);
      for (const f of subs) f();
      return a;
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
  return self;
}
