/**
 * The no-AI path for a whole song: the offline song generator (`core/song`) writes the chords, bass, melody and drums for a
 * request, and the song goes through the same steps as an AI's answer: one undo step, the arranger's fills and transitions,
 * the mix set up by role and leveled to the style's loudness, then played.
 */
import { mergeOfflinePrompt } from '@core/beat/local';
import type { PatternId, Project } from '@core/model/types';
import { generateSongFromPrompt } from '@core/song/generate';
import { songToAnswer } from '../song-answer';
import type { AssistantSession } from './session';
import { applyTurn } from './turn';

/** The name a new project's first, empty pattern has ("Pattern 1"). */
const DEFAULT_PATTERN_NAME = /^Pattern \d+$/;

/** The patterns a fresh project starts with and nobody used: default-named, no notes, not on the playlist. They would sit beside the song's patterns doing nothing. */
function unusedDefaultPatterns(project: Project): PatternId[] {
  const placed = new Set(
    Object.values(project.playlist.clips).flatMap((clip) => (clip.kind === 'pattern' ? [clip.patternId] : [])),
  );
  return project.patternOrder.filter((id) => {
    const pattern = project.patterns[id];
    if (!pattern || placed.has(id) || !DEFAULT_PATTERN_NAME.test(pattern.name)) return false;
    return Object.values(pattern.notes).every((notes) => Object.keys(notes ?? {}).length === 0);
  });
}

/**
 * Writes a song without an AI. `request` is added to everything asked so far (the generator is stateless); asking for a
 * song again in the same conversation gives another one (the variation counts the songs written so far).
 */
export async function writeOfflineSong(session: AssistantSession, request: string): Promise<void> {
  session.offlinePrompt = mergeOfflinePrompt(session.offlinePrompt, request);
  const plan = generateSongFromPrompt(session.offlinePrompt, { variation: session.offlineSongs });
  session.offlineSongs++;
  const answer = songToAnswer(plan);
  // Cleaning up after itself: the empty "Pattern 1" of a new project goes (its notes are nowhere, and the song has its own patterns).
  const leftovers = unusedDefaultPatterns(session.services.doc.getState().project);
  answer.actions.push(...leftovers.map((pattern) => ({ op: 'remove_pattern', pattern })));
  await applyTurn(session, answer, { take: null, request, analyzed: false, focus: null, offline: true });
  // The song's last pattern is not "the conversation's beat": a follow-up ("busier hats") must not rewrite it.
  session.store.setState({ applied: null });
}
