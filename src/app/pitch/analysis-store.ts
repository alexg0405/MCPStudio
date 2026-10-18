/**
 * Stored pitch analyses: the Pitch editor's analysis of a clip's part of a sample, kept in the app's IndexedDB `kv`
 * store so reopening a project (or the editor) does not listen to the same audio again. Keyed by the sample's content
 * hash, the sample rate, the analysed range and `PITCH_ANALYSIS_VERSION`, so an entry can never describe other audio or
 * the output of an older algorithm.
 *
 * Storage clean-up (docs/architecture.md, "Clean-up of unused audio"): the key ends in the hash and starts with
 * `pitch-analysis:`, so the collector does not count it as a use of the audio and deletes it with the blob; nothing here
 * pins audio. Stored values are plain data (typed arrays and numbers), never hashes of other things. Best effort:
 * every failure (no IndexedDB, a full disk, a damaged entry) is a cache miss.
 */
import { PITCH_ANALYSIS_VERSION, type PitchAnalysis } from '@core/voice/pitch-notes';
import { idbKv, isKvAvailable, PITCH_ANALYSIS_PREFIX, type GcKv } from '../storage/kv';

/** Entries kept (the newest by when they were stored); each is about 100 KB per minute of audio. */
export const PITCH_ANALYSIS_LIMIT = 24;

const CURRENT = `${PITCH_ANALYSIS_PREFIX}v${PITCH_ANALYSIS_VERSION}:`;

/** The key of an analysis: version, sample rate, range (seconds, 2 decimals) and the sample's hash (last, see the collector). */
export function pitchAnalysisKey(hash: string, sampleRate: number, from: number, to: number): string {
  return `${CURRENT}${sampleRate}:${from.toFixed(2)}:${to.toFixed(2)}:${hash}`;
}

interface Stored {
  version: number;
  /** Date.now() when stored. */
  at: number;
  analysis: PitchAnalysis;
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** A stored value that really is an analysis of this version (anything else is ignored). */
export function isStoredAnalysis(x: unknown): x is Stored {
  const v = x as Partial<Stored> | null;
  const a = v?.analysis as Partial<PitchAnalysis> | undefined;
  if (!v || v.version !== PITCH_ANALYSIS_VERSION || !isNumber(v.at) || !a) return false;
  if (!isNumber(a.t0) || !isNumber(a.hop) || !(a.hop > 0)) return false;
  if (!(a.f0 instanceof Float32Array) || !(a.conf instanceof Float32Array) || a.f0.length !== a.conf.length) return false;
  if (!Array.isArray(a.notes)) return false;
  return a.notes.every(
    (n) =>
      !!n &&
      isNumber(n.from) &&
      isNumber(n.to) &&
      isNumber(n.pitch) &&
      isNumber(n.drift) &&
      isNumber(n.vibratoDepth) &&
      isNumber(n.vibratoRate),
  );
}

export interface PitchAnalysisStore {
  get(key: string): Promise<PitchAnalysis | null>;
  set(key: string, analysis: PitchAnalysis): Promise<void>;
}

/** The store over a key-value store (the app's IndexedDB, or a memory one in tests). */
export function createPitchAnalysisStore(kv: GcKv, limit = PITCH_ANALYSIS_LIMIT): PitchAnalysisStore {
  let pruned = false;
  return {
    async get(key) {
      try {
        const v = (await kv.getMany([key])).get(key);
        return isStoredAnalysis(v) ? v.analysis : null;
      } catch {
        return null;
      }
    },
    async set(key, analysis) {
      try {
        await kv.set([[key, { version: PITCH_ANALYSIS_VERSION, at: Date.now(), analysis } satisfies Stored]]);
        const all = await kv.keys((k) => k.startsWith(PITCH_ANALYSIS_PREFIX));
        // Entries of older versions are never read again: gone once per session, and the oldest of the rest past the limit.
        const stale = pruned ? [] : all.filter((k) => !k.startsWith(CURRENT));
        pruned = true;
        const current = all.filter((k) => k.startsWith(CURRENT));
        let extra: string[] = [];
        if (current.length > limit) {
          const values = await kv.getMany(current);
          const stamped = current.map((k) => [k, (values.get(k) as Partial<Stored> | undefined)?.at ?? 0] as const);
          stamped.sort((a, b) => a[1] - b[1]);
          extra = stamped.slice(0, current.length - limit).map(([k]) => k);
        }
        if (stale.length || extra.length) await kv.del([...stale, ...extra]);
      } catch {
        // A cache: failing to write is only a missed shortcut.
      }
    },
  };
}

let current: PitchAnalysisStore | null = isKvAvailable() ? createPitchAnalysisStore(idbKv) : null;

/** The store `analyzeClip` uses (null: none). Tests swap it. */
export function pitchAnalysisStore(): PitchAnalysisStore | null {
  return current;
}

export function setPitchAnalysisStore(store: PitchAnalysisStore | null): void {
  current = store;
}
