/**
 * Reading the lead of a harmony: the sound the lead clip plays (a pitch correction's render when it has one), the sung notes in
 * the part it plays, and where each note sits in the song (so the chord track and key can be read at it). The analysis runs
 * in a Worker (`app/pitch`); nothing here changes the document.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { clipSourceRange, playbackMode, sourceRateAt, tickAtSourceSeconds, type PlaybackMode } from '@core/audio/playback';
import { monoMix } from '@core/audio/pitch-edit';
import type { LeadNote, SourceNote } from '@core/harmony/voices';
import type { TempoMap } from '@core/time/ppq';
import type { AudioClip, AudioClipChannel, ClipId, Project, SampleRef, Tick } from '@core/model/types';
import { playedSampleRef } from '@core/query/harmony-voices';
import type { SampleData } from '@engine/api';
import { analyzeInWorker } from '../pitch/pitch-jobs';
import type { Services } from '../services';

/** Said in plain words to the musician: why harmonies cannot be made or updated. */
export class HarmonyError extends Error {}

/** Seconds of the sample kept around the part the lead clip plays, so a note at its edge is whole. */
export const LEAD_MARGIN_SEC = 0.5;

/** The lead clip, the sound it plays and the notes sung in it. */
export interface Lead {
  clip: AudioClip;
  channel: AudioClipChannel;
  /** The sample the clip plays (its pitch correction's render when it has one). */
  ref: SampleRef;
  data: SampleData;
  /** The part of the sample the clip plays, seconds. */
  range: { from: number; to: number };
  /** The frames of the sample that get analysed and rendered: the range plus a margin. */
  startFrame: number;
  endFrame: number;
  /** The sung notes (sample time, the pitch as the sample holds it). */
  notes: SourceNote[];
  /** The same notes as the song hears them: pitch with the channel's pitch and speed, and song ticks. */
  leadNotes: LeadNote[];
}

/** Semitones the channel's playing shifts the sound at a tick (its pitch setting, and the speed when it follows by resampling). */
export function playbackSemitones(mode: PlaybackMode, tempo: TempoMap, tick: Tick): number {
  const rate = mode.follow === 'stretch' ? mode.pitch : sourceRateAt(mode, tempo, tick);
  return 12 * Math.log2(rate);
}

/** Why a clip cannot be a lead, in plain words (null when it can). */
export function leadProblem(project: Project, clipId: ClipId): string | null {
  const clip = project.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return 'Harmonies are made from a recorded vocal: choose an audio clip.';
  const channel = project.channels[clip.channelId];
  if (channel?.kind !== 'audioClip') return 'That clip has no audio.';
  if (channel.reverse) return 'Harmonies need the sound played forwards: turn off Reverse on this audio first.';
  if (!playedSampleRef(project, clip)) return 'This clip’s audio is missing.';
  return null;
}

/** Listens to the lead clip and returns what planning and rendering need. Throws `HarmonyError`. */
export async function prepareLead(s: Services, project: Project, clipId: ClipId): Promise<Lead> {
  const problem = leadProblem(project, clipId);
  if (problem) throw new HarmonyError(problem);
  const clip = project.playlist.clips[clipId] as AudioClip;
  const channel = project.channels[clip.channelId] as AudioClipChannel;
  const ref = playedSampleRef(project, clip) as SampleRef;
  const data = await s.engine.sampleData(ref);
  if (!data) throw new HarmonyError('This clip’s audio could not be read.');
  const tempo = tempoMapOf(project, 'song');
  const mode = playbackMode(channel);
  const range = clipSourceRange(clip, mode, tempo, data.duration);
  const rate = data.sampleRate;
  const total = data.channels[0]?.length ?? 0;
  const startFrame = Math.max(0, Math.floor((range.from - LEAD_MARGIN_SEC) * rate));
  const endFrame = Math.min(total, Math.ceil((range.to + LEAD_MARGIN_SEC) * rate));
  if (endFrame - startFrame < rate * 0.1) throw new HarmonyError('This clip is too short to hold a sung line.');
  const analysis = await analyzeInWorker(monoMix(data.channels, startFrame, endFrame), rate, startFrame / rate).result;
  const notes: SourceNote[] = analysis.notes
    .filter((n) => n.to > range.from && n.from < range.to)
    .map((n) => ({ from: n.from, to: n.to, pitch: n.pitch }));
  if (notes.length === 0) throw new HarmonyError('No sung notes were found in this clip. Harmonies need a clear single voice.');
  return { clip, channel, ref, data, range, startFrame, endFrame, notes, leadNotes: notes.map((n) => leadNoteOf(clip, mode, tempo, n)) };
}

/** A sung note as the song hears it. */
function leadNoteOf(clip: AudioClip, mode: PlaybackMode, tempo: TempoMap, note: SourceNote): LeadNote {
  const startTick = tickAtSourceSeconds(clip, mode, tempo, note.from);
  return {
    pitch: note.pitch + playbackSemitones(mode, tempo, startTick),
    startTick,
    endTick: tickAtSourceSeconds(clip, mode, tempo, note.to),
  };
}
