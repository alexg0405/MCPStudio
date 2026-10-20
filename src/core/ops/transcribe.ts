/**
 * Draft mutator for "Convert to MIDI": the notes of a conversion become a new pattern for one channel (a new instrument channel
 * or an existing one), optionally with pad sounds cut from the recording, a pattern clip placed on the playlist exactly where
 * the audio clip plays, the original muted, and the detected chords on the chord track. One call, so one undo step.
 */
import type { Draft } from 'immer';
import { makeLane, makePattern, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import type { ChannelId, ClipId, InstrumentChannel, Note, PatternClip, PatternId, Project, SampleId, SampleRef } from '../model/types';
import type { PlannedChord, PlannedNote } from '../audio/transcribe/types';
import { freeLaneRun } from '../query/lanes';
import { ceilToBars, TICKS_PER_STEP } from '../time/ppq';
import { addChannel, addSample, setPluginSample } from './channels';
import { clearChords, placeChords } from './chords';
import { addNotes } from './notes';
import { addClips, addLane, addPattern } from './playlist';

/** Everything one conversion writes. */
export interface TranscriptionWrite {
  /** The audio clip converted: the pattern clip goes where it plays. */
  audioClipId: ClipId;
  notes: readonly PlannedNote[];
  /** The notes are written for this channel: one that exists, or a new instrument channel to add (at `index`, or at the end). */
  channel: { kind: 'existing'; id: ChannelId } | { kind: 'new'; channel: InstrumentChannel; index?: number };
  patternName: string;
  /** Pad sounds cut from the recording: added to the project and put in the channel's sample slots. */
  slices: readonly { slot: string; sample: SampleRef }[];
  /** Place a pattern clip on the playlist where the audio clip plays. */
  placeOnPlaylist: boolean;
  /** Mute the audio clip so only the notes play. */
  muteOriginal: boolean;
  /** Chords for the chord track (song ticks), or none. */
  chords: readonly PlannedChord[];
}

/** What a write made. */
export interface TranscriptionWritten {
  patternId: PatternId;
  channelId: ChannelId;
  clipId: ClipId | null;
  notes: number;
}

/** The most steps a pattern's step grid is given: the grid is for the channel rack, the pattern's own length says how long it is. */
const MAX_STEPS = 512;

/** The notes as pattern notes (clamped keys, velocities and fine pitch, fresh ids). */
function patternNotes(planned: readonly PlannedNote[]): Note[] {
  return planned.map((note) => ({
    id: newId.note(),
    tick: Math.max(0, Math.round(note.tick)),
    length: Math.max(1, Math.round(note.length)),
    key: Math.max(0, Math.min(127, Math.round(note.key))),
    velocity: Math.max(0, Math.min(1, note.velocity)),
    ...(note.fine ? { fine: Math.max(-100, Math.min(100, Math.round(note.fine))) } : {}),
  }));
}

/** The lane the pattern clip goes on: the first track under the audio clip's with room, or a new one at the bottom. */
function laneUnder(d: Draft<Project>, audioLane: string, start: number, end: number) {
  const below = d.playlist.laneOrder.indexOf(audioLane as never) + 1;
  const index = freeLaneRun(d as unknown as Project, start, end, 1, below);
  const existing = d.playlist.laneOrder[index];
  if (existing && !d.playlist.lanes[existing]?.takes) return existing;
  const lane = makeLane(`Track ${d.playlist.laneOrder.length + 1}`);
  addLane(d, lane);
  return lane.id;
}

/** The chords as chord-track spans. */
function chordSpans(chords: readonly PlannedChord[]) {
  return chords.map((c) => ({
    tick: c.tick,
    length: c.length,
    chord: { root: c.root, quality: c.quality, ...(c.bass !== undefined ? { bass: c.bass } : {}) },
    confidence: c.confidence,
  }));
}

/** Writes a conversion into the project. Returns what it made, or null when the audio clip or the channel is not there. */
export function writeTranscription(d: Draft<Project>, write: TranscriptionWrite): TranscriptionWritten | null {
  const audio = d.playlist.clips[write.audioClipId];
  if (!audio || audio.kind !== 'audio') return null;
  const existing = write.channel.kind === 'existing' ? d.channels[write.channel.id] : undefined;
  if (write.channel.kind === 'existing' && existing?.kind !== 'instrument') return null;
  const channelId = write.channel.kind === 'existing' ? write.channel.id : write.channel.channel.id;
  if (write.channel.kind === 'new') addChannel(d, write.channel.channel, write.channel.index);
  for (const { slot, sample } of write.slices) {
    addSample(d, sample);
    setPluginSample(d, { kind: 'channel', channelId }, slot as string, sample.id as SampleId);
  }
  const pattern = makePattern(write.patternName.slice(0, 64), paletteColor(d.patternOrder.length));
  pattern.length = ceilToBars(audio.length, d.transport.timeSig);
  pattern.stepCount = Math.max(1, Math.min(MAX_STEPS, Math.round(pattern.length / TICKS_PER_STEP)));
  addPattern(d, pattern);
  addNotes(d, pattern.id, channelId, patternNotes(write.notes));
  let clipId: ClipId | null = null;
  if (write.placeOnPlaylist) {
    const clip: PatternClip = {
      id: newId.clip(),
      kind: 'pattern',
      laneId: laneUnder(d, audio.laneId, audio.start, audio.start + audio.length),
      start: audio.start,
      length: audio.length,
      patternId: pattern.id,
      offset: 0,
      name: write.patternName.slice(0, 64),
    };
    addClips(d, [clip]);
    clipId = clip.id;
  }
  if (write.muteOriginal) audio.muted = true;
  if (write.chords.length > 0) {
    // The stretch the chords cover is theirs: what was on the track there goes (chords outside it stay).
    clearChords(d, Math.min(...write.chords.map((c) => c.tick)), Math.max(...write.chords.map((c) => c.tick + c.length)));
    placeChords(d, chordSpans(write.chords));
  }
  return { patternId: pattern.id, channelId, clipId, notes: write.notes.length };
}
