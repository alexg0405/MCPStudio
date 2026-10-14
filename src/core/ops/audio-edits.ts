import type { Draft } from 'immer';
import type { AudioStretch, ChannelId, ClipId, Project } from '../model/types';

// Draft mutators for audio clip edits. Neutral values remove their field (absent = default).

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface AudioClipEdits {
  /** Linear gain 0–4 (1 = as recorded). */
  gain?: number;
  /** Seconds. */
  fadeIn?: number;
  fadeOut?: number;
}

/** Gain and fades of one playlist audio clip. */
export function setAudioClipEdits(d: Draft<Project>, id: ClipId, edits: AudioClipEdits): void {
  const clip = d.playlist.clips[id];
  if (clip?.kind !== 'audio') return;
  if (edits.gain !== undefined && Number.isFinite(edits.gain)) {
    const g = clamp(edits.gain, 0, 4);
    if (g === 1) delete clip.gain;
    else clip.gain = g;
  }
  for (const key of ['fadeIn', 'fadeOut'] as const) {
    const v = edits[key];
    if (v === undefined || !Number.isFinite(v)) continue;
    const s = clamp(v, 0, 3600);
    if (s === 0) delete clip[key];
    else clip[key] = s;
  }
}

export interface AudioChannelEdits {
  /** Cents −2400…2400. */
  pitch?: number;
  reverse?: boolean;
  stretch?: AudioStretch;
  /** BPM 20–999. */
  sourceBpm?: number;
}

/** Pitch, reverse and tempo-follow of an audio clip channel (every clip of it plays them). */
export function setAudioChannelEdits(d: Draft<Project>, id: ChannelId, edits: AudioChannelEdits): void {
  const ch = d.channels[id];
  if (ch?.kind !== 'audioClip') return;
  if (edits.pitch !== undefined && Number.isFinite(edits.pitch)) {
    const c = clamp(Math.round(edits.pitch * 100) / 100, -2400, 2400);
    if (c === 0) delete ch.pitch;
    else ch.pitch = c;
  }
  if (edits.reverse !== undefined) {
    if (edits.reverse) ch.reverse = true;
    else delete ch.reverse;
  }
  if (edits.stretch !== undefined) {
    if (edits.stretch === 'off') delete ch.stretch;
    else ch.stretch = edits.stretch;
  }
  if (edits.sourceBpm !== undefined && Number.isFinite(edits.sourceBpm))
    ch.sourceBpm = clamp(Math.round(edits.sourceBpm * 1000) / 1000, 20, 999);
}
