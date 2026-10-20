/**
 * Hearing the conversion before it is made: the first seconds of the clip rendered two ways with the engine's own offline
 * render (the notes through their instrument, exactly as they will play; and the audio alone), then mixed for "both", as three
 * WAV files that play on the audition bus. Nothing in the project changes: the notes are written into a copy of it.
 */
import { produce } from 'immer';
import { MODE_LABELS } from '@core/audio/transcribe';
import { encodeWav } from '@core/io/wav';
import type { Clip, ClipId, Project } from '@core/model/types';
import { writeTranscription } from '@core/ops/transcribe';
import { withoutMasterChain } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import { tempoMapOf } from '@core/automation/tempo';
import { renderOffline } from '@engine/render-offline';
import { trimExport } from '../export/export-wav';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { existingChannel, newChannelFor, planClip, type ConvertSpec } from './convert';
import { storePads } from './slices';

/** The most seconds of the clip an audition covers: enough to judge the notes, quick to make. */
export const AUDITION_SECONDS = 16;

/** Which of the three to hear. */
export type AuditionSide = 'audio' | 'midi' | 'both';

/** An audition as three audio files of the same length. */
export interface Audition {
  seconds: number;
  wav: Record<AuditionSide, Uint8Array>;
}

/** A copy of the project in which only the clips in `keep` play. */
function onlyPlaying(project: Project, keep: ReadonlySet<ClipId>): Project {
  return produce(project, (draft) => {
    for (const clip of Object.values(draft.playlist.clips) as Clip[]) clip.muted = !keep.has(clip.id);
  });
}

/** Renders [from, to) of a song-mode project to two channels at the engine's rate. */
async function renderPart(s: Services, project: Project, from: number, to: number): Promise<Float32Array[]> {
  const tempo = tempoMapOf(project, 'song');
  const seconds = tempo.tickToSeconds(to) - tempo.tickToSeconds(from);
  const result = await renderOffline(withoutMasterChain(project), {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: 'song', patternId: null, loop: null },
    bars: (to - from) / ticksPerBar(project.transport.timeSig),
    fromTick: from,
    sampleRate: s.engine.sampleRate,
    tail: 0.3,
    limiter: false,
  });
  return trimExport(result, seconds);
}

/** The sum of two renders turned down together when it would pass 0.95, and each of them by the same amount. */
function mixedLevels(audio: Float32Array[], midi: Float32Array[]): { audio: Float32Array[]; midi: Float32Array[]; both: Float32Array[] } {
  const length = Math.min(audio[0]?.length ?? 0, midi[0]?.length ?? 0);
  const channels = Math.max(audio.length, midi.length);
  const pick = (part: Float32Array[], c: number) => part[Math.min(c, part.length - 1)] as Float32Array;
  let peak = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs((pick(audio, c)[i] as number) + (pick(midi, c)[i] as number)));
  }
  const scale = peak > 0.95 ? 0.95 / peak : 1;
  const cut = (part: Float32Array[]) => Array.from({ length: channels }, (_, c) => pick(part, c).slice(0, length).map((v) => v * scale));
  const a = cut(audio);
  const m = cut(midi);
  const both = a.map((channel, c) => channel.map((v, i) => v + ((m[c] as Float32Array)[i] as number)));
  return { audio: a, midi: m, both };
}

/** Renders the audition of a conversion. Throws `TranscribeError`. */
export async function buildAudition(s: Services, spec: ConvertSpec): Promise<Audition> {
  const project = s.doc.getState().project;
  const plan = await planClip(s, spec.clip, spec.settings);
  const { transcription, source } = plan;
  const wantsPads = spec.settings.mode === 'drums' && spec.target.kind === 'new' && spec.slicePads !== false && transcription.pads.length > 0;
  const stored = wantsPads ? await whileBusy(() => storePads(source, transcription.pads, source.channel.name), { project }) : [];
  const channel = spec.target.kind === 'new' ? newChannelFor(s, project, spec.settings.mode, spec.target, source.channel.name, Object.fromEntries(stored.map((p) => [p.slot, p.sample.id]))) : existingChannel(project, spec.target.channel);
  const clip = source.clip;
  const tempo = tempoMapOf(project, 'song');
  const to = Math.min(clip.start + clip.length, Math.round(tempo.secondsToTick(tempo.tickToSeconds(clip.start) + AUDITION_SECONDS)));
  let madeClipId: ClipId | null = null;
  const withNotes = produce(project, (draft) => {
    const made = writeTranscription(draft, {
      audioClipId: spec.clip,
      notes: transcription.notes,
      channel: spec.target.kind === 'new' ? { kind: 'new', channel } : { kind: 'existing', id: channel.id },
      patternName: MODE_LABELS[spec.settings.mode].label,
      slices: stored,
      placeOnPlaylist: true,
      muteOriginal: false,
      chords: [],
    });
    madeClipId = made?.clipId ?? null;
  });
  if (!madeClipId) throw new Error('The notes could not be prepared for listening.');
  const audio = await renderPart(s, onlyPlaying(withNotes, new Set([spec.clip])), clip.start, to);
  const midi = await renderPart(s, onlyPlaying(withNotes, new Set([madeClipId])), clip.start, to);
  const mixes = mixedLevels(audio, midi);
  const rate = s.engine.sampleRate;
  const wav = (part: Float32Array[]) => encodeWav(part, rate, { bitDepth: 24 });
  return { seconds: (mixes.audio[0]?.length ?? 0) / rate, wav: { audio: wav(mixes.audio), midi: wav(mixes.midi), both: wav(mixes.both) } };
}

/** Plays one side of an audition on the audition bus. Resolves false when it could not be played. */
export function playAudition(s: Services, audition: Audition, side: AuditionSide): Promise<boolean> {
  return s.engine.previewAudio(audition.wav[side].slice().buffer as ArrayBuffer);
}
