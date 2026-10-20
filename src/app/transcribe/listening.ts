/**
 * Listening to a clip once and remembering it: what a mode heard (`Heard`) does not depend on the clip's place in the song, the
 * tempo or the quantize settings, so the dialog, the AI's reads and the conversion itself share the same result, and moving a
 * slider only plans again. A small memory cache (the last dozen listenings), keyed by the sound, the part and the sensitivity.
 */
import type { Heard, ModeSuggestion, TranscribeMode } from '@core/audio/transcribe';
import { listenInWorker, suggestInWorker } from './jobs';
import type { Source } from './source';

/** How many listenings and suggestions are kept. */
const KEPT = 12;

const heardBefore = new Map<string, Promise<Heard>>();
const suggestedBefore = new Map<string, Promise<ModeSuggestion>>();

/** Keeps a cache at its size, dropping the oldest entry; a failed job is not kept. */
function remember<T>(cache: Map<string, Promise<T>>, key: string, job: Promise<T>): Promise<T> {
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  if (cache.size > KEPT) cache.delete(cache.keys().next().value as string);
  return job;
}

/** The sensitivity as the cache knows it: the steps the dialog offers are twentieths. */
const stepOf = (sensitivity: number): number => Math.round(Math.max(0, Math.min(1, sensitivity)) * 20) / 20;

/** What a mode hears in the clip's sound. The first call listens (in a Worker); later ones with the same settings answer at once. */
export function hear(source: Source, mode: TranscribeMode, sensitivity: number): Promise<Heard> {
  const sens = stepOf(sensitivity);
  // The chord reading does not use the sensitivity: one listening serves every setting.
  const key = `${source.key}|${mode}|${mode === 'chords' ? '' : sens}`;
  const kept = heardBefore.get(key);
  if (kept) return kept;
  return remember(heardBefore, key, listenInWorker({ mode, mono: source.mono(), sampleRate: source.data.sampleRate, sensitivity: sens, startSec: source.startSec }));
}

/** The mode that fits the clip's sound, with the reason. */
export function suggest(source: Source): Promise<ModeSuggestion> {
  const kept = suggestedBefore.get(source.key);
  if (kept) return kept;
  return remember(suggestedBefore, source.key, suggestInWorker(source.mono(), source.data.sampleRate));
}

/** Forgets everything heard (tests, and a change of the audio engine's sample rate). */
export function forgetListening(): void {
  heardBefore.clear();
  suggestedBefore.clear();
}
