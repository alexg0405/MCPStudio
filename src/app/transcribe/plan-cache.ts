/**
 * The plans made lately, so a synchronous read (the AI's `get_midi_conversion`, the dialog's summary) can answer from what the
 * last `planClip` found without listening again. A plan is valid for the clip as it is now: its place, trim, tempo follow, the
 * song's tempo and swing and the settings are part of its signature, so a change makes the plan miss rather than go stale.
 */
import { playbackKey } from '@core/audio/playback';
import type { ModeSuggestion, Transcription, TranscribeSettings } from '@core/audio/transcribe';
import type { ClipId, Project } from '@core/model/types';

/** How many plans are kept. */
const KEPT = 8;

const plans = new Map<string, Transcription>();

/** What a plan depends on, as text; null when the clip or its channel is gone. */
export function planSignature(project: Project, clipId: ClipId, settings: TranscribeSettings): string | null {
  const clip = project.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return null;
  const channel = project.channels[clip.channelId];
  if (channel?.kind !== 'audioClip') return null;
  const sound = [clip.cleanup?.renderedSampleId, clip.align?.renderedSampleId, clip.pitchEdit?.renderedSampleId].join('|');
  return JSON.stringify([clipId, clip.start, clip.length, clip.offsetSec, playbackKey(channel), sound, project.transport.bpm, project.transport.swing, project.transport.timeSig, settings]);
}

/** Keeps the plan made for a clip as it is in `project`. */
export function rememberPlan(project: Project, clipId: ClipId, settings: TranscribeSettings, plan: Transcription): void {
  const key = planSignature(project, clipId, settings);
  if (!key) return;
  plans.delete(key);
  plans.set(key, plan);
  if (plans.size > KEPT) plans.delete(plans.keys().next().value as string);
}

/** The plan made for a clip as it is now, or null when none was. */
export function peekPlan(project: Project, clipId: ClipId, settings: TranscribeSettings): Transcription | null {
  const key = planSignature(project, clipId, settings);
  return key ? (plans.get(key) ?? null) : null;
}

/** The sound a clip plays and the part of it, as text (the suggestion does not depend on the tempo or the settings); null when the clip is gone. */
function soundSignature(project: Project, clipId: ClipId): string | null {
  const clip = project.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return null;
  const channel = project.channels[clip.channelId];
  if (channel?.kind !== 'audioClip') return null;
  return JSON.stringify([clipId, clip.offsetSec, clip.length, channel.sampleId, clip.cleanup?.renderedSampleId, clip.align?.renderedSampleId, clip.pitchEdit?.renderedSampleId]);
}

const suggestions = new Map<string, ModeSuggestion>();

/** Keeps the mode suggested for a clip's sound. */
export function rememberSuggestion(project: Project, clipId: ClipId, suggestion: ModeSuggestion): void {
  const key = soundSignature(project, clipId);
  if (!key) return;
  suggestions.set(key, suggestion);
  if (suggestions.size > KEPT) suggestions.delete(suggestions.keys().next().value as string);
}

/** The mode suggested for a clip's sound, or null when none was made yet. */
export function peekSuggestion(project: Project, clipId: ClipId): ModeSuggestion | null {
  const key = soundSignature(project, clipId);
  return key ? (suggestions.get(key) ?? null) : null;
}

/** Forgets every plan and suggestion (tests). */
export function forgetPlans(): void {
  plans.clear();
  suggestions.clear();
}
