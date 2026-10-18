/**
 * What the playlist's audio clips need decoded (pure; sample-residency.ts keeps it in memory): one item per buffer to
 * have (the sample, its reversed copy, a time-stretched copy of the part a clip plays) and one need per clip.
 */
import { clipSampleId, clipSourceRange, playbackMode, stretchScale, type PlaybackMode } from '@core/audio/playback';
import type { AudioClip, ChannelId, ClipId, Project, SampleRef } from '@core/model/types';
import { audibleClips } from '@core/query/playlist';
import { effectivelyMuted } from '@core/query/queries';
import type { TempoMap } from '@core/time/ppq';
import type { ClipSpan } from './residency-plan';
import { SampleCache } from './samples';

/** Seconds of extra source around a clip's part in its stretched copy (trim edits reuse it). */
const STRETCH_MARGIN_SEC = 1;

/** What a buffer in the plan is: the decoded sample, a reversed copy of it, or a time-stretched copy. */
export type ItemKind = 'source' | 'reverse' | 'stretch';

/** One buffer that may have to be in memory. */
export interface ResidencyItem {
  /** The cache key. */
  key: string;
  kind: ItemKind;
  ref: SampleRef;
  /** The cache key of the decoded sample the buffer comes from. */
  sourceKey: string;
  /** reverse/stretch: the buffer it is made from. */
  baseKey: string;
  scale: number;
  /** stretch: seconds of the base buffer copied (before clamping to its length). */
  from: number;
  to: number;
  /** The channels that play from it (they are told when it arrives). */
  channels: Set<ChannelId>;
}

/** What one playlist audio clip plays from. */
export interface ClipNeed extends ClipSpan {
  clipId: ClipId;
  channelId: ChannelId;
  sourceKey: string;
  baseKey: string;
  stretchKey: string | null;
  scale: number;
  /** Seconds of the base buffer where the stretched copy starts. */
  stretchFrom: number;
}

/** A stretched copy as a clip player reads it. */
export interface StretchedCopy {
  buffer: AudioBuffer;
  /** Seconds into the played (base) sample at the copy's first frame. */
  from: number;
}

/** The part of the base buffer a stretched copy is made from, in seconds. */
export interface StretchSpan {
  from: number;
  to: number;
}

/** The cache key of the buffer a channel plays from: the sample itself, or its reversed copy. */
export function baseKeyOf(sourceKey: string, reverse: boolean): string {
  return reverse ? `${sourceKey}|rev` : sourceKey;
}

/**
 * Only the part a clip plays (plus a margin), on whole seconds so small trims reuse the copy. The span does not depend
 * on the sample's length (known only once decoded); the copy is clamped to it.
 */
export function stretchSpanOf(clip: AudioClip, mode: PlaybackMode, tempo: TempoMap): StretchSpan {
  const range = clipSourceRange(clip, mode, tempo, Infinity);
  return {
    from: Math.max(0, Math.floor(range.from - STRETCH_MARGIN_SEC)),
    to: Math.ceil(range.to + STRETCH_MARGIN_SEC),
  };
}

/** The cache key of a stretched copy. 'st2' is the WSOLA version: copies kept on disk by an older one are not reused. */
export function stretchKeyOf(baseKey: string, scale: number, span: StretchSpan): string {
  return `${baseKey}|st2:${scale}:${span.from}-${span.to}`;
}

/** An item that is the sample itself or its reversed copy (made from the sample). */
export function plainItem(kind: 'source' | 'reverse', ref: SampleRef, sourceKey: string): Omit<ResidencyItem, 'key' | 'channels'> {
  return { kind, ref, sourceKey, baseKey: sourceKey, scale: 1, from: 0, to: 0 };
}

/** Every item the playlist's audible audio clips need, and one need per clip. Muted channels and clips without a sample need nothing. */
export function collectNeeds(
  project: Project,
  tempo: TempoMap,
  sampleRate: number,
): { needs: ClipNeed[]; items: Map<string, ResidencyItem> } {
  const muted = effectivelyMuted(project.channels);
  const needs: ClipNeed[] = [];
  const items = new Map<string, ResidencyItem>();
  const addItem = (key: string, init: Omit<ResidencyItem, 'key' | 'channels'>, channelId: ChannelId) => {
    let item = items.get(key);
    if (!item) items.set(key, (item = { ...init, key, channels: new Set() }));
    item.channels.add(channelId);
  };
  for (const clip of audibleClips(project)) {
    if (clip.kind !== 'audio') continue;
    const channel = project.channels[clip.channelId];
    if (channel?.kind !== 'audioClip' || muted.has(channel.id)) continue;
    // A pitch-corrected clip plays its render (the same length and timeline as the channel's sample).
    const ref = project.samples[clipSampleId(channel, clip)] ?? project.samples[channel.sampleId];
    if (!ref) continue;
    const mode = playbackMode(channel);
    const sourceKey = SampleCache.keyOf(ref.source, sampleRate);
    const baseKey = baseKeyOf(sourceKey, mode.reverse);
    addItem(sourceKey, plainItem('source', ref, sourceKey), channel.id);
    if (mode.reverse) addItem(baseKey, plainItem('reverse', ref, sourceKey), channel.id);
    const scale = mode.follow === 'stretch' ? stretchScale(mode, tempo, clip.start) : 1;
    let stretchKey: string | null = null;
    let stretchFrom = 0;
    if (scale !== 1) {
      const span = stretchSpanOf(clip, mode, tempo);
      stretchKey = stretchKeyOf(baseKey, scale, span);
      stretchFrom = span.from;
      addItem(stretchKey, { kind: 'stretch', ref, sourceKey, baseKey, scale, from: span.from, to: span.to }, channel.id);
    }
    needs.push({
      clipId: clip.id,
      channelId: channel.id,
      start: tempo.tickToSeconds(clip.start),
      end: tempo.tickToSeconds(clip.start + clip.length),
      keys: [],
      sourceKey,
      baseKey,
      stretchKey,
      scale,
      stretchFrom,
    });
  }
  return { needs, items };
}
