/**
 * The no-AI path for a whole song: the offline song generator (`core/song`) writes the chords, bass, melody and drums for a
 * request, and the song goes through the same steps as an AI's answer: one undo step, the arranger's fills and transitions,
 * the mix set up by role and leveled to the style's loudness, then played.
 */
import { mergeOfflinePrompt } from '@core/beat/local';
import { generateSongFromPrompt } from '@core/song/generate';
import { songToAnswer } from '../song-answer';
import type { AssistantSession } from './session';
import { applyTurn } from './turn';

/**
 * Writes a song without an AI. `request` is added to everything asked so far (the generator is stateless); asking for a
 * song again in the same conversation gives another one (the variation counts the songs written so far).
 */
export async function writeOfflineSong(session: AssistantSession, request: string): Promise<void> {
  session.offlinePrompt = mergeOfflinePrompt(session.offlinePrompt, request);
  const plan = generateSongFromPrompt(session.offlinePrompt, { variation: session.offlineSongs });
  session.offlineSongs++;
  await applyTurn(session, songToAnswer(plan), { take: null, request, analyzed: false, focus: null, offline: true });
  // The song's last pattern is not "the conversation's beat": a follow-up ("busier hats") must not rewrite it.
  session.store.setState({ applied: null });
}
