/**
 * FL import, song step: patterns and their notes, the playlist (tracks and clips of the open arrangement)
 * and the time markers.
 */
import { makeLane, makePattern, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import type { ChannelId, Clip, Marker, Note, Pattern, PatternId, LaneId } from '../model/types';
import { PPQ, ceilToBars } from '../time/ppq';
import { FLP_NOTE_SLIDE, type FlpArrangement, type FlpNote, type FlpPlaylistItem } from './flp';
import type { ChannelImport } from './flp-import-channels';
import { clamp, trimName, type FlpImportContext } from './flp-import-types';

/** The most steps a pattern may have. */
const STEP_MAX = 512;
const STEP_MIN = 16;
/** A 1/16 step in ticks (the pattern length is stored in steps). */
const TICKS_PER_STEP = 240;
/** The playlist always shows at least this many tracks, and at most this many. */
const MIN_LANES = 32;
const MAX_LANES = 500;

/** FL note fields are 0–128 (velocity, pan, release) and 0–240 (fine pitch). */
const FL_NOTE_VELOCITY_SCALE = 128;
const FL_NOTE_PAN_CENTER = 64;
const FL_NOTE_RELEASE_DEFAULT = 64;
const FL_NOTE_FINE_CENTER = 120;
/** FL's per-note fine pitch spans ±1 semitone over its 0–240 range. */
const FL_NOTE_FINE_RANGE_CENTS = 100;
const MIDI_KEY_MAX = 127;
/** A marker of this kind is a time signature marker. */
const MARKER_KIND_TIME_SIGNATURE = 1;

/** The patterns that were made: FL pattern number → ours, and where each one's notes end. */
export interface PatternImport {
  patternIds: Map<number, PatternId>;
  /** The end tick of each pattern's last note. */
  contentEnd: Map<PatternId, number>;
}

/** Builds `project.patterns` (when the file has any) from the FL patterns, adding their notes to the channels. */
export function importPatterns(ctx: FlpImportContext, channels: ChannelImport): PatternImport {
  const { flp, project, report } = ctx;
  const patternIds = new Map<number, PatternId>();
  const patterns: Record<PatternId, Pattern> = {};
  const patternOrder: PatternId[] = [];
  const contentEnd = new Map<PatternId, number>();

  const flPatterns = [...flp.patterns].sort((a, b) => a.iid - b.iid);
  flPatterns.forEach((flPattern, index) => {
    const id = newId.pattern();
    const pattern = makePattern(
      trimName(flPattern.name?.trim() || `Pattern ${flPattern.iid}`),
      flPattern.color ?? paletteColor(index),
      id,
    );
    let end = 0;
    for (const flNote of flPattern.notes) {
      if (flNote.flags & FLP_NOTE_SLIDE) {
        report.slideNotes++;
        continue;
      }
      const targets = instrumentsPlaying(ctx, channels, flNote.channel);
      if (targets.length === 0) {
        report.orphanNotes++;
        continue;
      }
      const start = ctx.tick(flNote.position);
      const length = Math.max(1, Math.round(flNote.length * ctx.scale));
      for (const channelId of targets) {
        const note = makeNote(flNote, start, length);
        (pattern.notes[channelId] ??= {})[note.id] = note;
        report.notes++;
      }
      end = Math.max(end, start + length);
    }
    contentEnd.set(id, end);
    pattern.stepCount = clamp(Math.round(ceilToBars(end, ctx.timeSignature) / TICKS_PER_STEP), STEP_MIN, STEP_MAX);
    patternIds.set(flPattern.iid, id);
    patterns[id] = pattern;
    patternOrder.push(id);
  });
  if (patternOrder.length > 0) {
    project.patterns = patterns;
    project.patternOrder = patternOrder;
  }
  report.patterns = patternOrder.length;
  return { patternIds, contentEnd };
}

/** The instrument channels that play an FL channel's notes: the channel itself, or a layer's children. */
function instrumentsPlaying(ctx: FlpImportContext, channels: ChannelImport, flIid: number): ChannelId[] {
  const children = channels.layers.get(flIid);
  const ids = children ? children.map((child) => channels.byIid.get(child)) : [channels.byIid.get(flIid)];
  return ids.filter((id): id is ChannelId => !!id && ctx.project.channels[id]?.kind === 'instrument');
}

function makeNote(flNote: FlpNote, start: number, length: number): Note {
  const note: Note = {
    id: newId.note(),
    tick: start,
    length,
    key: clamp(flNote.key, 0, MIDI_KEY_MAX),
    velocity: clamp(flNote.velocity / FL_NOTE_VELOCITY_SCALE, 0, 1),
  };
  if (flNote.pan !== FL_NOTE_PAN_CENTER)
    note.pan = clamp((flNote.pan - FL_NOTE_PAN_CENTER) / FL_NOTE_PAN_CENTER, -1, 1);
  if (flNote.release !== FL_NOTE_RELEASE_DEFAULT) note.release = clamp(flNote.release / FL_NOTE_VELOCITY_SCALE, 0, 1);
  if (flNote.fine !== FL_NOTE_FINE_CENTER) {
    // Fine pitch 0–240 around 120: read as ±1 semitone (FL's per-note fine pitch range).
    const cents = Math.round(((flNote.fine - FL_NOTE_FINE_CENTER) * FL_NOTE_FINE_RANGE_CENTS) / FL_NOTE_FINE_CENTER);
    if (cents !== 0) note.fine = clamp(cents, -FL_NOTE_FINE_RANGE_CENTS, FL_NOTE_FINE_RANGE_CENTS);
  }
  return note;
}

/**
 * Builds the playlist (tracks, then clips) and lengthens patterns that a clip plays past their content.
 * FL pattern clips don't loop their content, so the pattern gets an explicit length instead.
 */
export function importPlaylist(
  ctx: FlpImportContext,
  arrangement: FlpArrangement,
  channels: ChannelImport,
  patterns: PatternImport,
): void {
  const { project } = ctx;
  const laneIds = createLanes(ctx, arrangement);
  const patternNeeds = new Map<PatternId, number>();
  for (const item of arrangement.items) {
    const laneId = laneIds[item.track];
    const clip = laneId ? makeClip(ctx, item, laneId, channels, patterns, patternNeeds) : null;
    if (!clip) {
      ctx.report.skippedClips++;
      continue;
    }
    if (item.muted) clip.muted = true;
    project.playlist.clips[clip.id] = clip;
    ctx.report.clips++;
  }
  extendPatternsToFitClips(ctx, patterns, patternNeeds);
}

/** One lane per FL track up to the last one used or named (at least 32), with names, colours and mutes. */
function createLanes(ctx: FlpImportContext, arrangement: FlpArrangement): LaneId[] {
  const { project } = ctx;
  const tracks = arrangement.tracks;
  const lastTrackUsed = Math.max(
    -1,
    ...arrangement.items.map((item) => item.track),
    ...tracks.filter((track) => track.name).map((track) => track.index),
  );
  const laneCount = clamp(lastTrackUsed + 1, MIN_LANES, MAX_LANES);
  const laneIds: LaneId[] = [];
  project.playlist = { lanes: {}, laneOrder: [], clips: {}, markers: {} };
  for (let i = 0; i < laneCount; i++) {
    const track = tracks[i];
    const lane = makeLane(trimName(track?.name || `Track ${i + 1}`));
    if (track?.name && track.color) lane.color = track.color;
    if (track && !track.enabled) lane.muted = true;
    project.playlist.lanes[lane.id] = lane;
    project.playlist.laneOrder.push(lane.id);
    laneIds.push(lane.id);
  }
  return laneIds;
}

/**
 * The clip for a playlist item, or null when its pattern or channel isn't there. For pattern clips,
 * `patternNeeds` records how far into the pattern the clip plays.
 */
function makeClip(
  ctx: FlpImportContext,
  item: FlpPlaylistItem,
  laneId: LaneId,
  channels: ChannelImport,
  patterns: PatternImport,
  patternNeeds: Map<PatternId, number>,
): Clip | null {
  const start = ctx.tick(item.position);
  const length = Math.max(1, Math.round(item.length * ctx.scale));
  if (item.kind === 'pattern') {
    const patternId = patterns.patternIds.get(item.ref);
    if (!patternId) return null;
    const offset = item.startOffset !== null ? ctx.tick(item.startOffset) : 0;
    patternNeeds.set(patternId, Math.max(patternNeeds.get(patternId) ?? 0, offset + length));
    return { kind: 'pattern', id: newId.clip(), laneId, start, length, patternId, offset };
  }
  const channelId = channels.byIid.get(item.ref);
  const channel = channelId ? ctx.project.channels[channelId] : undefined;
  const beatOffset = item.startOffset !== null ? item.startOffset / ctx.flp.ppq : 0;
  if (channel?.kind === 'audioClip') {
    const bpm = ctx.project.transport.bpm;
    return {
      kind: 'audio',
      id: newId.clip(),
      laneId,
      start,
      length,
      channelId: channel.id,
      offsetSec: (beatOffset * 60) / bpm,
    };
  }
  if (channel?.kind === 'automation') {
    return {
      kind: 'automation',
      id: newId.clip(),
      laneId,
      start,
      length,
      channelId: channel.id,
      offset: Math.round(beatOffset * PPQ),
    };
  }
  return null;
}

/** FL pattern clips don't loop their content: make the pattern long enough to hold the longest clip. */
function extendPatternsToFitClips(ctx: FlpImportContext, patterns: PatternImport, needs: Map<PatternId, number>): void {
  for (const [id, need] of needs) {
    const pattern = ctx.project.patterns[id];
    const content = ceilToBars(patterns.contentEnd.get(id) ?? 0, ctx.timeSignature);
    if (pattern && need > content) {
      pattern.length = ceilToBars(need, ctx.timeSignature);
      pattern.stepCount = clamp(Math.round(pattern.length / TICKS_PER_STEP), STEP_MIN, STEP_MAX);
    }
  }
}

/** Time markers in order (time signature markers keep their signature as the name). */
export function importMarkers(ctx: FlpImportContext, arrangement: FlpArrangement): void {
  const markersInOrder = [...arrangement.markers].sort((a, b) => a.position - b.position);
  for (const flMarker of markersInOrder) {
    const isSignature = flMarker.kind === MARKER_KIND_TIME_SIGNATURE && flMarker.numerator && flMarker.denominator;
    const signature = isSignature ? `${flMarker.numerator}/${flMarker.denominator}` : '';
    const marker: Marker = {
      id: newId.marker(),
      tick: ctx.tick(flMarker.position),
      name: trimName(flMarker.name?.trim() || signature || 'Marker'),
    };
    ctx.project.playlist.markers[marker.id] = marker;
    ctx.report.markers++;
  }
}
