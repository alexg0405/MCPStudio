/**
 * The time part of the huge song (`huge-song.ts`): patterns and their notes, the playlist with its clips, take groups,
 * edited audio clips, markers, the chord track and the lyrics. The channels and the mixer already exist when this runs.
 */
import type { Draft } from 'immer';
import type { Rng } from '@agstudio/sdk/dsp/random';
import { cleanupSignature } from '@core/audio/cleanup-edit';
import { editSignature } from '@core/audio/pitch-edit/edit';
import { makeLane, makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import {
  type AudioClip,
  type AutomationClip,
  type ChannelId,
  type ChordEvent,
  type Clip,
  type ClipId,
  type LaneId,
  type Note,
  type PatternClip,
  type PatternId,
  type Project,
  type SampleId,
} from '@core/model/types';
import type { HugeChannels, HugeSongSize } from './huge-song';

const BAR = 3840;
const STEP = 240;
/** Pattern lengths in bars, cycled; most patterns are one or two bars, like loops. */
const PATTERN_BARS = [1, 1, 2, 2, 4];
/** Playlist tracks of each kind. */
const PATTERN_LANES = 24;
const AUTOMATION_LANES = 6;
const AUDIO_LANES = 6;
/** Takes of one recording, and the comp pieces made from them. */
const TAKES_PER_GROUP = 3;
const COMP_PIECES_PER_GROUP = 3;

/** What `addHugeArrangement` needs and finds. */
export interface HugeArrangementInput {
  size: Readonly<HugeSongSize>;
  channels: HugeChannels;
  /** The automation channels. */
  automation: ChannelId[];
  rng: Rng;
}

/** What it made, for tests and for the fixture's own set-up (which pattern and channel to open). */
export interface HugeArrangement {
  patterns: PatternId[];
  lanes: LaneId[];
  /** Pattern 1: sixteen bars with the thousands of notes. */
  bigPattern: PatternId;
}

/** Makes the patterns, the playlist and the song-long tracks (chords, lyrics, markers). */
export function addHugeArrangement(d: Draft<Project>, input: HugeArrangementInput): HugeArrangement {
  const { size, channels, rng } = input;
  const patterns = addPatterns(d, size, channels, rng);
  const lanes = addLanes(d, size.takeGroups);
  const takeClips = TAKES_PER_GROUP + COMP_PIECES_PER_GROUP;
  const audioClips = Math.round(size.clips * 0.12);
  const automationClips = Math.round(size.clips * 0.15);
  const patternClips = size.clips - audioClips - automationClips - size.takeGroups * takeClips;
  placePatternClips(d, lanes.slice(0, PATTERN_LANES), patterns, patternClips, size.bars, rng);
  placeAutomationClips(d, lanes.slice(PATTERN_LANES, PATTERN_LANES + AUTOMATION_LANES), input.automation, automationClips, size.bars, rng);
  const audioLanes = lanes.slice(PATTERN_LANES + AUTOMATION_LANES, PATTERN_LANES + AUTOMATION_LANES + AUDIO_LANES);
  const edited = placeAudioClips(d, audioLanes, channels.audio, audioClips, size.bars);
  addEdits(d, edited);
  addTakeGroups(d, lanes.slice(PATTERN_LANES + AUTOMATION_LANES + AUDIO_LANES), channels.audio[0] as ChannelId, size);
  addMarkers(d, size.bars);
  addChords(d, size.bars);
  addLyrics(d, size.bars);
  return { patterns, lanes, bigPattern: patterns[0] as PatternId };
}

/** One note, with a fresh id. */
function note(tick: number, length: number, key: number, velocity: number): Note {
  return { id: newId.note(), tick, length, key, velocity: Math.round(velocity * 100) / 100 };
}

/** Notes for one channel over `bars` bars: sixteenth-grid hits for drum pads, short phrases for the others. */
function notesFor(count: number, bars: number, isDrum: boolean, rng: Rng): Record<string, Note> {
  const notes: Record<string, Note> = {};
  const steps = bars * 16;
  for (let i = 0; i < count; i++) {
    const tick = Math.floor(rng.next() * steps) * STEP;
    const length = isDrum ? STEP / 2 : STEP * (1 + Math.floor(rng.next() * 4));
    const key = isDrum ? 36 + Math.floor(rng.next() * 16) : 36 + Math.floor(rng.next() * 48);
    const made = note(tick, length, key, 0.4 + rng.next() * 0.6);
    notes[made.id] = made;
  }
  return notes;
}

/** The patterns: the first is the big one (sixteen bars on one synth), the others are small loops on three to five channels. */
function addPatterns(d: Draft<Project>, size: Readonly<HugeSongSize>, channels: HugeChannels, rng: Rng): PatternId[] {
  const usable = channels.instruments.filter((id) => !channels.idle.includes(id));
  const ids: PatternId[] = [];
  const perChannel = Math.max(1, Math.round(size.otherNotes / Math.max(1, size.patterns - 1) / 4));
  for (let k = 0; k < size.patterns; k++) {
    const isBig = k === 0;
    const bars = isBig ? 16 : (PATTERN_BARS[k % PATTERN_BARS.length] as number);
    const pattern = makePattern(isBig ? 'Big lead' : `Loop ${k + 1}`, paletteColor(k));
    pattern.length = bars * BAR;
    pattern.stepCount = bars * 16;
    if (isBig) {
      pattern.notes[channels.instruments[0] as ChannelId] = notesFor(size.bigPatternNotes, bars, false, rng);
    } else {
      const channelCount = 3 + (k % 3);
      for (let c = 0; c < channelCount; c++) {
        const channelId = usable[(k * 7 + c * 13) % usable.length] as ChannelId;
        const isDrum = channels.drumPads.includes(channelId);
        const count = Math.max(1, Math.round(perChannel * bars * (0.5 + rng.next())));
        pattern.notes[channelId] = notesFor(count, bars, isDrum, rng);
      }
    }
    d.patterns[pattern.id] = pattern as never;
    d.patternOrder.push(pattern.id);
    ids.push(pattern.id);
  }
  return ids;
}

/** The playlist tracks: pattern tracks, automation tracks, audio tracks, then four tracks (a comp and three takes) per take group. */
function addLanes(d: Draft<Project>, takeGroups: number): LaneId[] {
  const names = [
    ...Array.from({ length: PATTERN_LANES }, (_, i) => `Track ${i + 1}`),
    ...Array.from({ length: AUTOMATION_LANES }, (_, i) => `Automation ${i + 1}`),
    ...Array.from({ length: AUDIO_LANES }, (_, i) => `Audio ${i + 1}`),
  ];
  for (let g = 0; g < takeGroups; g++) {
    names.push(`Vocal ${g + 1} · comp`);
    for (let t = TAKES_PER_GROUP; t >= 1; t--) names.push(`Vocal ${g + 1} · take ${t}`);
  }
  return names.map((name) => {
    const lane = makeLane(name);
    d.playlist.lanes[lane.id] = lane as never;
    d.playlist.laneOrder.push(lane.id);
    return lane.id;
  });
}

/** Where the n-th of `perLane` clips of a track starts (in bars) and how many bars it may take before the next one. */
function slotOf(index: number, perLane: number, bars: number): { startBar: number; roomBars: number } {
  const stride = bars / perLane;
  const startBar = Math.floor(index * stride);
  const nextBar = Math.floor((index + 1) * stride);
  return { startBar, roomBars: Math.max(1, nextBar - startBar) };
}

/** Spreads `count` clips over `lanes` in turn; `make(lane, startBar, roomBars, n)` builds each one. */
function spread(lanes: readonly LaneId[], count: number, bars: number, make: (lane: LaneId, startBar: number, roomBars: number, n: number) => Clip): Clip[] {
  const made: Clip[] = [];
  const perLane = Math.ceil(count / lanes.length);
  for (let n = 0; n < count; n++) {
    const lane = lanes[n % lanes.length] as LaneId;
    const { startBar, roomBars } = slotOf(Math.floor(n / lanes.length), perLane, bars);
    made.push(make(lane, startBar, roomBars, n));
  }
  return made;
}

/** Stores clips in the playlist. */
function put(d: Draft<Project>, clips: readonly Clip[]): void {
  for (const clip of clips) d.playlist.clips[clip.id] = clip as never;
}

/** Pattern clips: every pattern is played at least once, the rest of the clips repeat patterns at random. */
function placePatternClips(d: Draft<Project>, lanes: readonly LaneId[], patterns: readonly PatternId[], count: number, bars: number, rng: Rng): void {
  const clips = spread(lanes, count, bars, (laneId, startBar, roomBars, n) => {
    const patternId = n < patterns.length ? (patterns[n] as PatternId) : (patterns[Math.floor(rng.next() * patterns.length)] as PatternId);
    const patternBars = (d.patterns[patternId]?.length ?? BAR) / BAR;
    const lengthBars = Math.min(roomBars, patternBars * (rng.next() < 0.25 ? 2 : 1));
    const clip: PatternClip = {
      kind: 'pattern',
      id: newId.clip() as ClipId,
      laneId,
      start: startBar * BAR,
      length: lengthBars * BAR,
      patternId,
      offset: 0,
    };
    return clip;
  });
  put(d, clips);
}

/** Automation clips: each plays one automation channel's curve over two to five bars. */
function placeAutomationClips(d: Draft<Project>, lanes: readonly LaneId[], automation: readonly ChannelId[], count: number, bars: number, rng: Rng): void {
  const clips = spread(lanes, count, bars, (laneId, startBar, roomBars, n) => {
    const clip: AutomationClip = {
      kind: 'automation',
      id: newId.clip() as ClipId,
      laneId,
      start: startBar * BAR,
      length: Math.min(roomBars, 2 + Math.floor(rng.next() * 4)) * BAR,
      channelId: automation[n % automation.length] as ChannelId,
      offset: 0,
    };
    return clip;
  });
  put(d, clips);
}

/** Audio clips on the audio tracks; the first few are returned so `addEdits` can give them pitch and cleanup edits. */
function placeAudioClips(d: Draft<Project>, lanes: readonly LaneId[], audio: readonly ChannelId[], count: number, bars: number): AudioClip[] {
  const clips = spread(lanes, count, bars, (laneId, startBar, roomBars, n) => {
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip() as ClipId,
      laneId,
      start: startBar * BAR,
      length: Math.min(roomBars, 2) * BAR,
      channelId: audio[n % audio.length] as ChannelId,
      offsetSec: 0,
    };
    if (n % 5 === 0) clip.fadeIn = 0.02;
    if (n % 7 === 0) clip.gain = 0.8;
    return clip;
  });
  put(d, clips);
  return clips as AudioClip[];
}

/** A stand-in for a render: another built-in sample of the project (nothing renders in the fixture). */
function standInRender(d: Draft<Project>): SampleId {
  const ids = Object.keys(d.samples) as SampleId[];
  return ids[ids.length - 1] as SampleId;
}

/** Four clips with a pitch edit and two with a cleanup, each with the signature its "render" claims to be made from. */
function addEdits(d: Draft<Project>, clips: readonly AudioClip[]): void {
  const renderedSampleId = standInRender(d);
  clips.slice(0, 4).forEach((clip, i) => {
    const pitchEdit = {
      notes: [
        { from: 0, to: 0.4, pitch: 60 + i, shift: 25 },
        { from: 0.5, to: 0.9, pitch: 64 + i, drift: 0.5, vibrato: 0.5 },
      ],
    };
    const stored = d.playlist.clips[clip.id] as Draft<AudioClip>;
    stored.pitchEdit = { ...pitchEdit, renderedSampleId, renderedFor: editSignature(pitchEdit) };
  });
  clips.slice(4, 6).forEach((clip) => {
    const cleanup = { noise: { amountDb: 12, sensitivity: 0.5, from: 0, to: 0.2 }, clicks: { sensitivity: 0.5 } };
    const stored = d.playlist.clips[clip.id] as Draft<AudioClip>;
    stored.cleanup = { ...cleanup, renderedSampleId, renderedFor: cleanupSignature(cleanup) };
  });
}

/** Take groups: a comp track over three take tracks, the takes muted, the comp built from pieces of each. */
function addTakeGroups(d: Draft<Project>, takeLanes: readonly LaneId[], channelId: ChannelId, size: Readonly<HugeSongSize>): void {
  const perGroup = 1 + TAKES_PER_GROUP;
  for (let g = 0; g < size.takeGroups; g++) {
    const group = `huge-take-${g + 1}`;
    const compLane = takeLanes[g * perGroup] as LaneId;
    const startBar = Math.floor((g * size.bars) / Math.max(1, size.takeGroups)) + 2;
    d.playlist.lanes[compLane]!.takes = { group, role: 'comp' };
    for (let t = 0; t < TAKES_PER_GROUP; t++) {
      const laneId = takeLanes[g * perGroup + 1 + (TAKES_PER_GROUP - 1 - t)] as LaneId;
      d.playlist.lanes[laneId]!.takes = { group, role: 'take' };
      const take: AudioClip = {
        kind: 'audio',
        id: newId.clip() as ClipId,
        laneId,
        start: startBar * BAR,
        length: 4 * BAR,
        channelId,
        offsetSec: 0,
        name: `Vocal ${g + 1} · take ${t + 1}`,
        color: paletteColor(t),
        muted: true,
        take: { group, index: t },
      };
      d.playlist.clips[take.id] = take as never;
    }
    const pieceBars = [1, 2, 1];
    let at = startBar;
    pieceBars.forEach((lengthBars, index) => {
      const piece: AudioClip = {
        kind: 'audio',
        id: newId.clip() as ClipId,
        laneId: compLane,
        start: at * BAR,
        length: lengthBars * BAR,
        channelId,
        offsetSec: (at - startBar) * 1.875,
        color: paletteColor(index),
        take: { group, index, comp: true },
      };
      d.playlist.clips[piece.id] = piece as never;
      at += lengthBars;
    });
  }
}

/** A marker every 8 bars ("Section 1", …). */
function addMarkers(d: Draft<Project>, bars: number): void {
  for (let bar = 0, n = 1; bar < bars; bar += 8, n++) {
    const id = newId.marker();
    d.playlist.markers[id] = { id, tick: bar * BAR, name: `Section ${n}` };
  }
}

/** The chord track: one chord a bar, over an A minor progression. */
function addChords(d: Draft<Project>, bars: number): void {
  const progression: [root: number, quality: string][] = [
    [9, 'min'],
    [5, 'maj'],
    [0, 'maj'],
    [7, 'm7'],
  ];
  const chords: Record<string, ChordEvent> = {};
  for (let bar = 0; bar < bars; bar++) {
    const [root, quality] = progression[bar % progression.length] as [number, string];
    const id = newId.chord();
    chords[id] = { id, tick: bar * BAR, length: BAR, root, quality };
  }
  d.chords = chords as never;
}

const WORDS = ['moon', 'light', 'run', 'fall', 'to', 'the', 'night', 'we', 'stay', 'under', 'neon', 'sky', 'heart', 'beat', 'slow', 'down'];

/** Lyrics: three words a bar from the ninth bar on, a new line every four bars. */
function addLyrics(d: Draft<Project>, bars: number): void {
  const lyrics: Project['lyrics'] = {};
  let word = 0;
  for (let bar = 8; bar < bars - 4; bar++) {
    for (let w = 0; w < 3; w++) {
      const id = newId.lyric();
      lyrics[id] = {
        id,
        tick: bar * BAR + w * Math.round(BAR / 4),
        length: Math.round(BAR / 4) - 60,
        text: WORDS[word++ % WORDS.length] as string,
        line: Math.floor((bar - 8) / 4),
      };
    }
  }
  d.lyrics = lyrics as never;
}
