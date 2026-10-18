/**
 * "Detect chords": reads the chords the song plays (notes of the chord, pad, keys and bass parts, and audio clips through
 * the DJ chromagram) and fills the chord track. One undo step. The reading itself is `core/harmony`.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode } from '@core/audio/playback';
import { chromagram } from '@core/dj/chroma';
import { detectClipChords } from '@core/harmony/audio';
import type { DetectedSpan } from '@core/harmony/detect';
import { detectProjectChords, type HarmonyScope } from '@core/harmony/scan';
import type { AudioClip, Clip, ClipId, Project, Tick } from '@core/model/types';
import { clearChords, placeChords } from '@core/ops/chords';
import { ticksPerBar } from '@core/time/ppq';
import { audioChannelOf } from '../actions/audio-clips';
import { rolesOf } from '../arrange/env';
import type { Services } from '../services';
import type { ActionResult } from './chord-track';

/** What the musician can ask to read, in their words: the whole song, the clips selected in the playlist, the loop region, or the current pattern. */
export type DetectWhere = 'song' | 'selection' | 'loop' | 'pattern';

export interface DetectOptions {
  where?: DetectWhere;
  /** A reading per bar (default) or per half bar. */
  resolution?: 'bar' | 'half';
  /** Keep chords already on the track outside the stretch that was read (default true); false clears the whole track first. */
  keepOutside?: boolean;
}

/** The scope a place stands for, or null (with the reason) when it has nothing to read. */
export function scopeFor(s: Services, where: DetectWhere): { scope: HarmonyScope; clipIds: ClipId[] } | string {
  const project = s.doc.getState().project;
  if (where === 'song') return { scope: { kind: 'song' }, clipIds: [] };
  if (where === 'loop') {
    const loop = s.view.getState().loop;
    return loop ? { scope: { kind: 'range', from: loop.start, to: loop.end }, clipIds: [] } : 'There is no loop region: drag on the playlist ruler to set one.';
  }
  if (where === 'pattern') {
    const patternId = s.view.getState().currentPatternId;
    return patternId && project.patterns[patternId] ? { scope: { kind: 'patterns', patternIds: [patternId] }, clipIds: [] } : 'There is no current pattern.';
  }
  const clipIds = s.editor.getState().clipSelection.filter((id) => !!project.playlist.clips[id]);
  return clipIds.length ? { scope: { kind: 'clips', clipIds }, clipIds: [...clipIds] } : 'Select some clips in the playlist first.';
}

/** The audio clips (unmuted) a read covers: the selected ones, or every one overlapping the loop or the whole song. */
function audioClipsFor(project: Project, where: DetectWhere, clipIds: readonly ClipId[], loop: { start: Tick; end: Tick } | null): AudioClip[] {
  if (where === 'pattern') return [];
  const wanted = new Set<ClipId>(clipIds);
  const clips = Object.values(project.playlist.clips) as Clip[];
  return clips.filter((clip): clip is AudioClip => {
    if (clip.kind !== 'audio' || clip.muted) return false;
    if (where === 'selection') return wanted.has(clip.id);
    if (where === 'loop' && loop) return clip.start < loop.end && clip.start + clip.length > loop.start;
    return true;
  });
}

/** Reads one audio clip's chords. Null when its sound is not available. */
async function readAudioClip(s: Services, clip: AudioClip, resolution: 'bar' | 'half'): Promise<DetectedSpan[] | null> {
  const project = s.doc.getState().project;
  const channel = audioChannelOf(project, clip);
  const sample = channel ? project.samples[channel.sampleId] : undefined;
  if (!channel || !sample) return null;
  const data = await s.engine.sampleData(sample);
  if (!data) return null;
  const length = data.channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const samples of data.channels) for (let i = 0; i < length; i++) mono[i] = (mono[i] as number) + (samples[i] as number) / data.channels.length;
  const mode = playbackMode(channel);
  if (mode.reverse) mono.reverse();
  const analysis = chromagram(mono, data.sampleRate);
  return detectClipChords(analysis, clip, mode, tempoMapOf(project, 'song'), { bar: ticksPerBar(project.transport.timeSig), resolution });
}

/** The stretch of the song some spans cover. */
function coverage(spans: readonly DetectedSpan[]): { from: Tick; to: Tick } {
  return { from: Math.min(...spans.map((span) => span.tick)), to: Math.max(...spans.map((span) => span.tick + span.length)) };
}

/**
 * Reads the chords of a place and puts them on the chord track (replacing what was there under the stretch that was read).
 * Notes come first; audio clips are read when the place has no chord notes of its own or is a selection of clips.
 */
export async function detectChords(s: Services, options: DetectOptions = {}): Promise<ActionResult> {
  const where = options.where ?? 'song';
  const resolution = options.resolution ?? 'bar';
  const picked = scopeFor(s, where);
  if (typeof picked === 'string') return { ok: false, message: picked };
  const project = s.doc.getState().project;
  const spans = detectProjectChords(project, rolesOf(project), picked.scope, { resolution });
  const audio = audioClipsFor(project, where, picked.clipIds, s.view.getState().loop);
  let fromAudio = 0;
  if (audio.length && (spans.length === 0 || where === 'selection')) {
    for (const clip of audio) {
      const read = await readAudioClip(s, clip, resolution);
      if (read) {
        spans.push(...read);
        fromAudio += read.length;
      }
    }
  }
  if (spans.length === 0) {
    return { ok: false, message: 'Found no chords to read: it needs a chords, pad, keys or bass part with at least two notes at once (or audio).' };
  }
  const { from, to } = coverage(spans);
  s.history.transact('Detect chords', (draft) => {
    if (options.keepOutside === false) clearChords(draft);
    else clearChords(draft, from, to);
    placeChords(draft, spans);
  });
  const unsure = spans.filter((span) => span.confidence < 0.5).length;
  const source = fromAudio ? ' (including audio)' : '';
  const doubt = unsure ? `; ${unsure} are guesses (shown faded)` : '';
  return { ok: true, message: `Found ${spans.length} chord${spans.length === 1 ? '' : 's'}${source}${doubt}.` };
}
