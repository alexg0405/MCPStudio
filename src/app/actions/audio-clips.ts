/**
 * Audio clip edits as user actions: gain and fades (per clip), reverse, pitch and tempo follow (per
 * audio clip channel: every clip of that sound), normalize, slicing at transients, source tempo
 * detection. Each one is a single undo step with a plain label. Clips are given by id, or the
 * selected audio clips are used (menus, commands and the AI share these).
 */
import { tempoMapOf } from '@core/automation/tempo';
import { normalizeGain, type ClipLevels } from '@core/audio/envelope';
import {
  clipSourceRange,
  mirroredOffset,
  naturalLength,
  playbackMode,
  tickAtSourceSeconds,
  type FollowMode,
  type PlaybackMode,
} from '@core/audio/playback';
import { detectTempo, detectTransients } from '@core/audio/transients';
import { newId } from '@core/model/ids';
import type { AudioClip, AudioClipChannel, ChannelId, ClipId, Project, SampleRef } from '@core/model/types';
import { setAudioChannelEdits, setAudioClipEdits, type AudioChannelEdits } from '@core/ops/audio-edits';
import { splitClip } from '@core/ops/playlist';
import type { Draft } from 'immer';
import type { Services } from '../services';
import { kitDuration } from './samples';

/** The audio clips an edit acts on: the given ids, or the selected audio clips. */
export function audioClipsFor(s: Services, ids?: readonly ClipId[]): AudioClip[] {
  const p = s.doc.getState().project;
  const list = ids ?? s.editor.getState().clipSelection;
  return list.map((id) => p.playlist.clips[id]).filter((c): c is AudioClip => c?.kind === 'audio');
}

/** The audio clip channel of a clip. */
export function audioChannelOf(p: Project, clip: AudioClip): AudioClipChannel | null {
  const ch = p.channels[clip.channelId];
  return ch?.kind === 'audioClip' ? ch : null;
}

/** Seconds the channel's sample lasts, when the document knows it (imported files, recordings, kit sounds). */
export function sampleSeconds(p: Project, ch: AudioClipChannel): number | null {
  const ref = p.samples[ch.sampleId];
  if (!ref) return null;
  if (ref.durationSec && ref.durationSec > 0) return ref.durationSec;
  if (ref.source.kind === 'builtin') return kitDuration(ref.source.generator) || null;
  return null;
}

/** Gain (linear 0–4) and fades (seconds) of clips, one undo step. */
export function setClipLevels(s: Services, clips: readonly AudioClip[], edits: ClipLevels, label: string): void {
  if (clips.length === 0) return;
  const tempo = tempoMapOf(s.doc.getState().project, 'song');
  s.history.transact(label, (d) => {
    for (const c of clips) setAudioClipEdits(d, c.id, edits, { tempo });
  });
}

/**
 * Changes how a channel plays (pitch, reverse, tempo follow) and keeps its clips on the same audio:
 * reversing mirrors each clip's trim (it plays the same part backwards), and clips that played the
 * whole rest of the sound are resized to keep doing so.
 */
function editChannel(s: Services, channelId: ChannelId, edits: AudioChannelEdits, label: string): void {
  const p = s.doc.getState().project;
  const ch = p.channels[channelId];
  if (ch?.kind !== 'audioClip') return;
  const tempo = tempoMapOf(p, 'song');
  const dur = sampleSeconds(p, ch);
  const before = playbackMode(ch);
  s.history.transact(label, (d) => {
    setAudioChannelEdits(d, channelId, edits);
    const next = d.channels[channelId];
    if (next?.kind !== 'audioClip' || dur === null) return;
    const after = playbackMode(next);
    for (const clip of Object.values(d.playlist.clips)) {
      if (clip.kind !== 'audio' || clip.channelId !== channelId) continue;
      const whole = Math.abs(clip.length - naturalLength(clip, before, tempo, dur)) <= Math.max(4, clip.length * 0.002);
      if (before.reverse !== after.reverse) clip.offsetSec = mirroredOffset(clip, before, tempo, dur);
      if (whole) clip.length = naturalLength(clip, after, tempo, dur);
    }
  });
}

const modeName: Record<FollowMode, string> = { off: 'Off', resample: 'Resample', stretch: 'Stretch' };

export function setReverse(s: Services, channelId: ChannelId, reverse: boolean): void {
  editChannel(s, channelId, { reverse }, reverse ? 'Reverse' : 'Play forwards');
}

/** Pitch in cents (−2400…2400). */
export function setPitch(s: Services, channelId: ChannelId, cents: number): void {
  editChannel(s, channelId, { pitch: cents }, `Pitch ${formatCents(cents)}`);
}

/** How the channel follows the song tempo; resample and stretch need a source tempo (BPM). */
export function setFollowTempo(s: Services, channelId: ChannelId, mode: FollowMode, sourceBpm?: number): void {
  editChannel(
    s,
    channelId,
    { stretch: mode, ...(sourceBpm !== undefined ? { sourceBpm } : {}) },
    `Follow tempo: ${modeName[mode]}`,
  );
}

export function setSourceBpm(s: Services, channelId: ChannelId, bpm: number): void {
  editChannel(s, channelId, { sourceBpm: bpm }, `Source tempo ${Math.round(bpm * 100) / 100} BPM`);
}

/** "+3 st", "−1 st 50 ct", "0 st". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '−' : cents > 0 ? '+' : '';
  const a = Math.abs(Math.round(cents));
  const st = Math.trunc(a / 100);
  const ct = a % 100;
  return `${sign}${st} st${ct ? ` ${ct} ct` : ''}`;
}

/** The (reversed when reverse is on) sample a channel plays, for analysis. */
async function playedAudio(
  s: Services,
  ref: SampleRef,
  mode: PlaybackMode,
): Promise<{ channels: Float32Array[]; sampleRate: number; duration: number } | null> {
  const data = await s.engine.sampleData(ref);
  if (!data) return null;
  const channels = mode.reverse ? data.channels.map((c) => c.slice().reverse()) : (data.channels as Float32Array[]);
  return { channels, sampleRate: data.sampleRate, duration: data.duration };
}

/** Sets each clip's gain so its loudest sample peaks at −0.3 dBFS; returns how many changed. */
export async function normalizeClips(s: Services, clips: readonly AudioClip[]): Promise<number> {
  const p = s.doc.getState().project;
  const tempo = tempoMapOf(p, 'song');
  const gains = new Map<ClipId, number>();
  for (const clip of clips) {
    const ch = audioChannelOf(p, clip);
    const ref = ch ? p.samples[ch.sampleId] : undefined;
    if (!ch || !ref) continue;
    const mode = playbackMode(ch);
    const data = await s.engine.sampleData(ref);
    if (!data) continue;
    const range = clipSourceRange(clip, mode, tempo, data.duration);
    // The clip plays the reversed sample: its range sits at the other end of the original.
    const from = mode.reverse ? data.duration - range.to : range.from;
    const to = mode.reverse ? data.duration - range.from : range.to;
    let peak = 0;
    const a = Math.floor(from * data.sampleRate);
    const b = Math.ceil(to * data.sampleRate);
    for (const c of data.channels) for (let i = a; i < Math.min(b, c.length); i++) peak = Math.max(peak, Math.abs(c[i] as number));
    if (peak > 0) gains.set(clip.id, normalizeGain(peak));
  }
  if (gains.size === 0) return 0;
  s.history.transact(gains.size > 1 ? 'Normalize clips' : 'Normalize clip', (d) => {
    for (const [id, gain] of gains) setAudioClipEdits(d, id, { gain }, { tempo });
  });
  return gains.size;
}

/**
 * Splits a clip at every hit (drum hits, plucked notes) so each one can be moved, muted or deleted
 * on its own; returns the number of slices (1 = nothing found).
 */
export async function sliceAtTransients(
  s: Services,
  clip: AudioClip,
  opts: { sensitivity?: number } = {},
): Promise<number> {
  const p = s.doc.getState().project;
  const ch = audioChannelOf(p, clip);
  const ref = ch ? p.samples[ch.sampleId] : undefined;
  if (!ch || !ref) return 0;
  const mode = playbackMode(ch);
  const audio = await playedAudio(s, ref, mode);
  if (!audio) return 0;
  const tempo = tempoMapOf(p, 'song');
  const range = clipSourceRange(clip, mode, tempo, audio.duration);
  const hits = detectTransients(audio.channels, audio.sampleRate, { from: range.from, to: range.to, ...opts });
  // Slices shorter than ~a 1/64 note are left joined.
  const minTicks = 60;
  const cuts: number[] = [];
  for (const t of hits) {
    const tick = Math.round(tickAtSourceSeconds(clip, mode, tempo, t));
    if (tick - clip.start < minTicks || clip.start + clip.length - tick < minTicks) continue;
    if (cuts.length && tick - (cuts[cuts.length - 1] as number) < minTicks) continue;
    cuts.push(tick);
  }
  if (cuts.length === 0) return 1;
  s.history.transact(`Slice at transients (${cuts.length + 1} slices)`, (d: Draft<Project>) => {
    let id = clip.id;
    for (const at of cuts) {
      const right = newId.clip();
      splitClip(d, id, at, tempo, right);
      id = right;
    }
  });
  return cuts.length + 1;
}

/** The tempo the channel's sound was played at, from its audio (null when there is no clear beat). */
export async function detectSourceBpm(s: Services, channelId: ChannelId): Promise<number | null> {
  const p = s.doc.getState().project;
  const ch = p.channels[channelId];
  const ref = ch?.kind === 'audioClip' ? p.samples[ch.sampleId] : undefined;
  if (!ref) return null;
  const data = await s.engine.sampleData(ref);
  if (!data) return null;
  return detectTempo(data.channels, data.sampleRate, { beatsPerBar: p.transport.timeSig.num });
}
