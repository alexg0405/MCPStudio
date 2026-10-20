/**
 * Reading the audio of a clip for "Convert to MIDI": checks the clip can be converted, finds the sound it plays (a pitch
 * correction's render when it has one), the part of it the clip plays with a little margin, and the clip's playback maths
 * (`ClipTimeline`) the planner lands notes with. Nothing here changes the document.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { clipSourceRange, playbackMode } from '@core/audio/playback';
import { monoMix } from '@core/audio/pitch-edit';
import type { ClipTimeline } from '@core/audio/transcribe';
import type { AudioClip, AudioClipChannel, ClipId, Project, SampleRef } from '@core/model/types';
import { playedSampleRef } from '@core/query/harmony-voices';
import { ticksPerBar, ticksPerBeat } from '@core/time/ppq';
import type { SampleData } from '@engine/api';
import type { Services } from '../services';

/** Said in plain words to the musician: why a clip cannot be converted. */
export class TranscribeError extends Error {}

/** Seconds of sound kept around the part the clip plays, so a note or hit at its edge is whole. */
export const MARGIN_SEC = 0.25;
/** The longest clip converted (s): longer than this is a song, not a loop or a take. */
export const MAX_SECONDS = 600;
/** The shortest part worth listening to (s). */
const MIN_SECONDS = 0.1;

/** The clip, the sound it plays and the part of it that is listened to. */
export interface Source {
  clip: AudioClip;
  channel: AudioClipChannel;
  ref: SampleRef;
  data: SampleData;
  /** The part of the sample the clip plays, seconds. */
  range: { from: number; to: number };
  /** The frames listened to: the range plus a margin. */
  startFrame: number;
  endFrame: number;
  /** Where the listened part starts on the sample's timeline, seconds. */
  startSec: number;
  /** A fresh mono copy of the listened part each call (a job takes the buffer it is given). */
  mono(): Float32Array;
  /** Names the sound and the part, for caching what was heard. */
  key: string;
}

/** Why a clip cannot be converted, in plain words (null when it can). */
export function sourceProblem(project: Project, clipId: ClipId): string | null {
  const clip = project.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return 'Convert to MIDI works on a recorded or imported sound: choose an audio clip.';
  const channel = project.channels[clip.channelId];
  if (channel?.kind !== 'audioClip') return 'That clip has no audio.';
  if (channel.reverse) return 'Convert to MIDI needs the sound played forwards: turn off Reverse on this audio first.';
  if (!playedSampleRef(project, clip)) return 'This clip’s audio is missing.';
  return null;
}

/** The clip's playback maths and the song's meter, for the planner. */
export function timelineOfClip(project: Project, clip: AudioClip, channel: AudioClipChannel): ClipTimeline {
  return {
    clip: { start: clip.start, length: clip.length, offsetSec: clip.offsetSec },
    mode: playbackMode(channel),
    tempo: tempoMapOf(project, 'song'),
    beatTicks: ticksPerBeat(project.transport.timeSig),
    barTicks: ticksPerBar(project.transport.timeSig),
    songSwing: project.transport.swing,
  };
}

/** What names a stored sound for caching: its content hash when it has one, else its id. */
function soundKey(ref: SampleRef): string {
  return ref.source.kind === 'embedded' ? ref.source.hash : `${ref.source.generator}@${ref.source.version}`;
}

/** Finds and reads the audio of a clip. Throws `TranscribeError`. */
export async function prepareSource(s: Services, project: Project, clipId: ClipId): Promise<Source> {
  const problem = sourceProblem(project, clipId);
  if (problem) throw new TranscribeError(problem);
  const clip = project.playlist.clips[clipId] as AudioClip;
  const channel = project.channels[clip.channelId] as AudioClipChannel;
  const ref = playedSampleRef(project, clip) as SampleRef;
  const data = await s.engine.sampleData(ref);
  if (!data) throw new TranscribeError('This clip’s audio could not be read.');
  const tempo = tempoMapOf(project, 'song');
  const range = clipSourceRange(clip, playbackMode(channel), tempo, data.duration);
  if (range.to - range.from < MIN_SECONDS) throw new TranscribeError('This clip is too short to convert.');
  if (range.to - range.from > MAX_SECONDS) throw new TranscribeError('This clip is longer than 10 minutes: cut out the part to convert first.');
  const rate = data.sampleRate;
  const total = data.channels[0]?.length ?? 0;
  const startFrame = Math.max(0, Math.floor((range.from - MARGIN_SEC) * rate));
  const endFrame = Math.min(total, Math.ceil((range.to + MARGIN_SEC) * rate));
  return {
    clip,
    channel,
    ref,
    data,
    range,
    startFrame,
    endFrame,
    startSec: startFrame / rate,
    mono: () => monoMix(data.channels, startFrame, endFrame),
    key: `${soundKey(ref)}|${rate}|${startFrame}|${endFrame}`,
  };
}
