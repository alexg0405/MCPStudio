/**
 * Reading the harmony voices of a project: which clips are voices, which lead each follows, and whether a voice is out of date
 * (the lead's sound, the part of it the lead plays, the song key or the chords differ from what its render was made from).
 */
import { tempoMapOf } from '../automation/tempo';
import { clipSampleId, clipSourceRange, playbackMode } from '../audio/playback';
import { harmonySignature, type SignatureInput } from '../harmony/voices/signature';
import type { AudioClip, AudioClipChannel, ChannelId, ClipId, GuideNote, HarmonyVoiceRecord, Note, Project, SampleRef } from '../model/types';
import { chordsBetween } from './chords';
import { patternLength } from './queries';

/** One harmony voice: its sound (a channel; split clips share it) and the clips that play it. */
export interface HarmonyVoice {
  channelId: ChannelId;
  /** The clips of the voice, in the order of the playlist's record. */
  clipIds: ClipId[];
  /** How the voice was made (the same on every clip of the channel). */
  record: HarmonyVoiceRecord;
}

/** A short name for a sample's audio by content: the same bytes give the same text. */
export function sampleKeyOf(ref: SampleRef): string {
  return ref.source.kind === 'embedded' ? `${ref.source.hash}.${ref.source.ext}` : `${ref.source.generator}@${ref.source.version}`;
}

/** The audio clip, or null when the id is not one. */
function audioClip(project: Project, id: ClipId): AudioClip | null {
  const clip = project.playlist.clips[id];
  return clip?.kind === 'audio' ? clip : null;
}

/** The channel an audio clip plays through, or null. */
function audioChannelOf(project: Project, clip: AudioClip): AudioClipChannel | null {
  const channel = project.channels[clip.channelId];
  return channel?.kind === 'audioClip' ? channel : null;
}

/** The sound a clip plays: its channel's sample, or the render of its pitch correction. Null when the project does not have it. */
export function playedSampleRef(project: Project, clip: AudioClip): SampleRef | null {
  const channel = audioChannelOf(project, clip);
  if (!channel) return null;
  return project.samples[clipSampleId(channel, clip)] ?? null;
}

/**
 * What a voice's render is made from, as `harmonySignature` reads it, or null when the lead (or its sound) is gone.
 * `record` supplies the rule and settings; the lead is the clip the record names.
 */
export function harmonyInputs(project: Project, record: HarmonyVoiceRecord): SignatureInput | null {
  const lead = audioClip(project, record.source);
  const channel = lead ? audioChannelOf(project, lead) : null;
  const ref = lead ? playedSampleRef(project, lead) : null;
  if (!lead || !channel || !ref) return null;
  const mode = playbackMode(channel);
  const range = clipSourceRange(lead, mode, tempoMapOf(project, 'song'), ref.durationSec ?? Infinity);
  const key = project.transport.key;
  return {
    sound: `${sampleKeyOf(ref)}|${mode.cents}|${mode.follow}|${mode.sourceBpm ?? ''}`,
    from: range.from,
    to: range.to,
    start: lead.start,
    rule: record.rule,
    formantCents: record.formantCents,
    humanize: record.humanize,
    seed: record.seed,
    key: key ? `${key.root}:${key.scale}` : '',
    chords: chordsBetween(project, lead.start, lead.start + lead.length),
    bpm: project.transport.bpm,
  };
}

/** The signature the voice should have now (null when its lead is gone). */
export function currentHarmonySignature(project: Project, record: HarmonyVoiceRecord): string | null {
  const inputs = harmonyInputs(project, record);
  return inputs ? harmonySignature(inputs) : null;
}

/** Every harmony voice of the project, one per channel, in the order of their first clip. */
export function harmonyVoices(project: Project): HarmonyVoice[] {
  const byChannel = new Map<ChannelId, HarmonyVoice>();
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'audio' || !clip.harmony) continue;
    const found = byChannel.get(clip.channelId);
    if (found) found.clipIds.push(clip.id);
    else byChannel.set(clip.channelId, { channelId: clip.channelId, clipIds: [clip.id], record: clip.harmony });
  }
  return [...byChannel.values()].sort((a, b) => a.record.group.localeCompare(b.record.group) || a.record.voice - b.record.voice);
}

/** The voices made from a lead clip. */
export function voicesOfLead(project: Project, leadId: ClipId): HarmonyVoice[] {
  return harmonyVoices(project).filter((v) => v.record.source === leadId);
}

/** The voices whose render no longer matches their lead, chords or key (the lead being gone does not count: nothing to update from). */
export function staleHarmonyVoices(project: Project): HarmonyVoice[] {
  return harmonyVoices(project).filter((v) => {
    const now = currentHarmonySignature(project, v.record);
    return now !== null && now !== v.record.renderedFor;
  });
}

/** The most guide notes a channel gives (a rule keeps this many). */
const MAX_GUIDE_NOTES = 4096;

/**
 * The notes a channel plays in the song, as a guide melody for "sing these notes": every pattern clip's notes at the place the
 * clip plays them (looping as the clip does), even when the channel is muted (a guide is often silent), in song order.
 */
export function guideNotesOfChannel(project: Project, channelId: ChannelId): GuideNote[] {
  const out: GuideNote[] = [];
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.muted) continue;
    const pattern = project.patterns[clip.patternId];
    const notes = pattern?.notes[channelId];
    if (!pattern || !notes) continue;
    const span = patternLength(pattern, project.transport.timeSig);
    if (span <= 0) continue;
    for (const note of Object.values(notes) as Note[]) {
      if (note.muted || note.tick >= span) continue;
      let local = note.tick - (clip.offset % span);
      while (local < 0) local += span;
      for (; local < clip.length; local += span) {
        out.push({ tick: clip.start + local, length: Math.max(1, Math.min(note.length, span - note.tick, clip.length - local)), pitch: note.key });
      }
    }
  }
  out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  return out.slice(0, MAX_GUIDE_NOTES);
}
