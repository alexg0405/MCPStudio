/**
 * The assistant's offline brain: reads a description ("dark trap 808s at 140 in F minor") and the
 * user's performance (hits and hummed notes on the grid) and writes a beat with style templates:
 * the style's drum grid with its accents and swing, an 808 that follows the kick and slides (trap,
 * drill), a sub bass under the kick (boom bap), 7th-chord keys (lo-fi), offbeat bass (house, EDM)
 * and chords (EDM, pop). No network, deterministic for the same input, used when no AI is set up.
 *
 * The work is split by job in `local/`: `prompt.ts` reads the request, `drums.ts` writes the drum
 * tracks, `bass.ts` and `progressions.ts` the pitched parts, `performance.ts` turns what the user
 * played into notes and `generate.ts` puts the beat together. This file keeps the import path every
 * caller uses.
 */
export type { Style } from './style';
export { generateLocalBeat } from './local/generate';
export { mergeOfflinePrompt, parsePrompt } from './local/prompt';
export type { LocalBeatInput, PerformanceRole, PerformedEvent, PromptInfo } from './local/types';
