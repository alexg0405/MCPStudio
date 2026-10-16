/**
 * Makes the decks the first time something asks for them (the Decks window, a controller, the Studio): the
 * deck code, the player worklets and the audio graph are not loaded at startup. `services.decks()` always
 * resolves to the same `DecksApi`.
 */
import { idbGet, idbSet, isIdbAvailable } from '@platform/idb';
import type { Services } from '../services';
import { peekAnalysis, trackAnalyzer } from './analyzer';
import type { DecksApi, DecksFactory } from './decks-api';
import type { DecksDeps, SavedCues } from './decks';

const CUES_PREFIX = 'dj-deck-cues:';

const isSaved = (x: unknown): x is SavedCues => {
  const o = x as SavedCues | null;
  return !!o && typeof o.cuePoint === 'number' && Array.isArray(o.hotCues);
};

/** Cue points and hot cues per song, in this browser's key-value store. */
const idbCues: NonNullable<DecksDeps['cues']> = {
  async load(hash) {
    if (!isIdbAvailable()) return null;
    const v = await idbGet<unknown>(`${CUES_PREFIX}${hash}`);
    return isSaved(v) ? v : null;
  },
  save(hash, cues) {
    if (isIdbAvailable()) void idbSet(`${CUES_PREFIX}${hash}`, cues).catch(() => {});
  },
};

/** The decks' view of the app. */
export function decksDepsFor(s: Services): DecksDeps {
  return {
    host: () => s.engine.deckHost?.() ?? null,
    subscribeHost: (fn) => s.engine.subscribe(fn),
    resume: () => s.engine.resume(),
    cache: s.sampleCache,
    peekAnalysis: (ref) => peekAnalysis(s, ref),
    analysis: async (ref) => {
      const a = trackAnalyzer(s);
      return a ? a.analyze(s, ref) : null;
    },
    addRecording: async (file, title) => {
      const { addSongFiles } = await import('./library');
      return (await addSongFiles(s, [file])) > 0 ? title : null;
    },
    toast: (message, kind) => s.session.getState().toast(message, kind),
    cues: idbCues,
  };
}

export function createDecksFactory(services: () => Services): DecksFactory {
  let made: Promise<DecksApi> | null = null;
  return () => (made ??= import('./decks').then(({ createDecks }) => createDecks(decksDepsFor(services()))));
}
