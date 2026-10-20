/**
 * Vocal cleanup of audio clips as user actions (the Clean up vocal window, the AI and MCP share these): settings that
 * are one undo step each, the noise stretch, the breath markers, and the listening switches (before/after, and the sound
 * that was taken out). The renderer that keeps the cleaned audio up to date is `cleanup-render.ts`.
 *
 * The cleanup is non-destructive like the pitch editor's render: the clip keeps `cleanup` settings, a render of them
 * is a new sample played instead of the recording, and the recording stays. Order of a clip's sound: recording, then
 * cleanup, then pitch correction (see `playback.ts`).
 */
import { tempoMapOf } from '@core/automation/tempo';
import { applyCleanupRequest, describeCleanup, isNeutralCleanup, type CleanupRequest } from '@core/audio/cleanup-edit';
import { MIN_NOISE_SECONDS } from '@core/audio/cleanup/noise-profile';
import { clipSourceRange, playbackMode, sourceSecondsAt } from '@core/audio/playback';
import { removedSound } from '@core/audio/cleanup/render';
import type { AudioClip, ClipId, Project, VocalCleanup } from '@core/model/types';
import { setBreathOff, setCleanup } from '@core/ops/cleanup';
import { encodeLossless } from '../export/encode';
import { cleanupState } from '../cleanup/state';
import type { Services } from '../services';
import { audioClipOf } from './pitch-clip';
import { CLEANUP_MAX_SECONDS } from './cleanup-render';

export { renderCleanupNow, startCleanupRenderer } from './cleanup-render';

/** The clip's cleanup settings, or null when it has none. */
export function cleanupOf(p: Project, clipId: ClipId): VocalCleanup | null {
  return audioClipOf(p, clipId)?.clip.cleanup ?? null;
}

/** Why a clip can't be cleaned up, in plain words (null when it can). */
export function cleanupProblem(p: Project, clipId: ClipId): string | null {
  const found = audioClipOf(p, clipId);
  if (!found) return 'That is not an audio clip.';
  const ref = p.samples[found.channel.sampleId];
  if (!ref) return 'This clip’s audio is missing.';
  if (ref.durationSec !== undefined && ref.durationSec > CLEANUP_MAX_SECONDS) {
    return 'This sound is over 15 minutes long: cut the clip out of it first, then clean it up.';
  }
  return null;
}

/** The audio clip the window should open for: the selected one, else the only one with a cleanup, else the only audio clip. */
export function defaultCleanupClip(s: Services): ClipId | null {
  const p = s.doc.getState().project;
  for (const id of s.editor.getState().clipSelection) if (p.playlist.clips[id]?.kind === 'audio') return id;
  const audio = Object.values(p.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
  const cleaned = audio.filter((c) => c.cleanup);
  if (cleaned.length === 1) return (cleaned[0] as AudioClip).id;
  return audio.length === 1 ? (audio[0] as AudioClip).id : null;
}

/** Writes new settings as one undo step (consecutive changes with the same `mergeKey` within a second share one). */
export function commitCleanup(s: Services, clipId: ClipId, cleanup: VocalCleanup | null, label: string, mergeKey?: string): boolean {
  return s.history.transact(label, (d) => setCleanup(d, clipId, cleanup), mergeKey ? { mergeKey } : {});
}

/** Applies a request (sections on, changed or off) to a clip. One undo step; a slider's drags merge through `mergeKey`. */
export function changeCleanup(s: Services, clipId: ClipId, request: CleanupRequest, label = 'Clean up vocal', mergeKey?: string): boolean {
  const before = cleanupOf(s.doc.getState().project, clipId) ?? undefined;
  const next = applyCleanupRequest(before, request);
  return commitCleanup(s, clipId, isNeutralCleanup(next) ? null : next, label, mergeKey);
}

/** Removes the cleanup of a clip (it plays its recording again); one undo step. */
export function clearClipCleanup(s: Services, clipId: ClipId): boolean {
  if (!cleanupOf(s.doc.getState().project, clipId)) return false;
  return commitCleanup(s, clipId, null, 'Remove vocal cleanup');
}

/**
 * Learns the noise from a stretch of the clip's sample (seconds on the sample's own timeline): the noise section is
 * switched on if it was off. Returns an explanation when the stretch is too short.
 */
export function learnNoiseFrom(s: Services, clipId: ClipId, from: number, to: number): string | null {
  if (!(to - from >= MIN_NOISE_SECONDS)) return `Pick at least ${MIN_NOISE_SECONDS} seconds of only the room sound (the longer the better).`;
  const before = cleanupOf(s.doc.getState().project, clipId) ?? undefined;
  const base = applyCleanupRequest(before, before?.noise ? {} : { noiseDb: 12 });
  const noise = base.noise;
  if (!noise) return 'Noise reduction could not be switched on.';
  const next: VocalCleanup = { ...base, noise: { ...noise, from, to } };
  commitCleanup(s, clipId, next, 'Learn the noise from a quiet part');
  return null;
}

/** Forgets the learned stretch: the render finds the quietest half second again. */
export function learnNoiseAutomatically(s: Services, clipId: ClipId): boolean {
  const before = cleanupOf(s.doc.getState().project, clipId);
  if (!before?.noise) return false;
  const { from: _from, to: _to, ...rest } = before.noise;
  return commitCleanup(s, clipId, { ...before, noise: rest }, 'Find the quiet part automatically');
}

/**
 * The loop region of the song (the playlist's time selection) as seconds of the clip's sample, or null when there is no
 * loop region or it does not overlap the clip.
 */
export function loopRegionInSample(s: Services, clipId: ClipId): { from: number; to: number } | null {
  const p = s.doc.getState().project;
  const found = audioClipOf(p, clipId);
  const loop = s.view.getState().loop;
  if (!found || !loop) return null;
  const clip = found.clip;
  const start = Math.max(loop.start, clip.start);
  const end = Math.min(loop.end, clip.start + clip.length);
  if (end <= start) return null;
  const tempo = tempoMapOf(p, 'song');
  const mode = playbackMode(found.channel);
  const a = sourceSecondsAt(clip, mode, tempo, start);
  const b = sourceSecondsAt(clip, mode, tempo, end);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** Switches one found breath on or off (the marker on the clip); one undo step. */
export function toggleBreath(s: Services, clipId: ClipId, index: number): boolean {
  const span = cleanupOf(s.doc.getState().project, clipId)?.breaths?.spans?.[index];
  if (!span) return false;
  return s.history.transact(span.off ? 'Turn this breath down again' : 'Keep this breath', (d) => void setBreathOff(d, clipId, index, !span.off));
}

/** The one-sentence state of a clip's cleanup, for toasts and the AI. */
export function cleanupSummary(p: Project, clipId: ClipId): string {
  const c = cleanupOf(p, clipId);
  return c ? describeCleanup(c) : 'no cleanup';
}

// ---- Listening ----

/**
 * Before/after: hear the clip as recorded, without the cleanup (or the pitch correction made from it) when `original`
 * is true, or the cleaned sound again (false); without `original` it switches. Session state only: nothing in the
 * document changes. Returns true when the recording is heard now.
 */
export function hearUncleaned(s: Services, clipId: ClipId, original?: boolean): boolean {
  const ed = s.editor.getState();
  const next = original ?? !ed.cleanupOriginal.includes(clipId);
  ed.setCleanupOriginal(clipId, next);
  return next;
}

/** Plays what the cleanup took out of the clip (the recording minus the cleaned sound) on the preview bus; the window's "Hear what was removed". */
export async function hearRemoved(s: Services, clipId: ClipId): Promise<string | null> {
  const p = s.doc.getState().project;
  const found = audioClipOf(p, clipId);
  const settings = found?.clip.cleanup;
  if (!found || !settings?.renderedSampleId) return 'The cleaned sound is not ready yet: wait for the render to finish, then try again.';
  const original = p.samples[found.channel.sampleId];
  const cleaned = p.samples[settings.renderedSampleId];
  if (!original || !cleaned) return 'The clip’s audio could not be found.';
  const [a, b] = await Promise.all([s.engine.sampleData(original), s.engine.sampleData(cleaned)]);
  if (!a || !b) return 'The clip’s audio could not be read.';
  const range = clipSourceRange(found.clip, playbackMode(found.channel), tempoMapOf(p, 'song'), a.duration);
  const first = Math.max(0, Math.floor(range.from * a.sampleRate));
  const last = Math.min(a.channels[0]?.length ?? 0, Math.ceil(range.to * a.sampleRate));
  const removed = removedSound(
    a.channels.map((c) => c.subarray(first, last)),
    b.channels.map((c) => c.subarray(first, last)),
  );
  const bytes = encodeLossless(removed, a.sampleRate, { codec: 'wav', bits: 16, kbps: 0 });
  cleanupState.setState({ hearingRemoved: true });
  const ok = await s.engine.previewAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return ok ? null : 'The removed sound could not be played.';
}

/** Stops the "what was removed" sound. */
export function stopHearingRemoved(s: Services): void {
  s.engine.stopPreview();
  cleanupState.setState({ hearingRemoved: false });
}
