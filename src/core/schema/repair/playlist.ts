/** Repair of the playlist: its tracks (lanes), clips and markers. Takes and comping are in `takes.ts`. */
import { sanitizePitchEdit } from '../../audio/pitch-edit';
import { type RepairLog, CLIP, LANE, MARKER, countOf } from './log';
import { TICK_MAX } from './limits';
import { FieldRepairs } from './fields';
import { repairOrder, repairRecords } from './records';
import { repairTakes } from './takes';
import { hasOwn, isBoolean, isObject, isSet, isString, type JsonObject } from '../json-values';

/** A clip whose length is not a number becomes one 4/4 bar (3840 ticks at 960 per beat). */
const DEFAULT_CLIP_LENGTH_TICKS = 3840;
/** The loudest gain of an audio clip (linear: +12 dB). */
const CLIP_GAIN_MAX = 4;
/** The longest fade of an audio clip, in seconds. */
const CLIP_FADE_MAX_SEC = 3600;
/** The longest marker name kept, in characters. */
const MARKER_NAME_MAX_LENGTH = 64;

/** Repairs the playlist's tracks, clips (dropping orphans), take tags and markers. */
export function repairPlaylist(project: JsonObject, log: RepairLog): void {
  const playlist = project.playlist as JsonObject;
  repairLanes(playlist, log);
  repairClips(playlist, project, log);
  log.flush();
  repairTakes(playlist, log);
  repairMarkers(playlist, log);
}

function repairLanes(playlist: JsonObject, log: RepairLog): void {
  const lanes = playlist.lanes as JsonObject;
  const knownIds = repairRecords(lanes, LANE, log);
  Object.values(lanes).forEach((entry, index) => {
    const fixes = new FieldRepairs(entry as JsonObject);
    fixes.require('name', isString, `Track ${index + 1}`);
    fixes.require('muted', isBoolean, false);
    fixes.dropIfInvalid('solo', isBoolean);
    fixes.dropIfInvalid('color', isString);
    if (fixes.changed) log.count('lane-fields', (n) => `Fixed ${countOf(n, LANE)} with invalid settings.`);
  });
  log.flush();
  playlist.laneOrder = repairOrder(playlist.laneOrder as unknown[], lanes, knownIds, 'playlist track list', LANE, log);
}

/** Removes clips of an unknown type or whose pattern, channel or track is gone; fixes the rest. */
function repairClips(playlist: JsonObject, project: JsonObject, log: RepairLog): void {
  const clips = playlist.clips as JsonObject;
  repairRecords(clips, CLIP, log);
  for (const [id, entry] of Object.entries(clips)) {
    const clip = entry as JsonObject;
    const kind = clip.kind;
    if (kind !== 'pattern' && kind !== 'audio' && kind !== 'automation') {
      delete clips[id];
      log.count('clip-kind', (n) => `Removed ${countOf(n, CLIP)} of an unknown type.`);
      continue;
    }
    if (!clipPointsAtExistingThings(clip, project)) {
      delete clips[id];
      log.count('clip-orphan', (n) => `Removed ${countOf(n, CLIP)} whose pattern, channel or track no longer exists.`);
      continue;
    }
    const fixes = new FieldRepairs(clip);
    fixes.clampInteger('start', 0, TICK_MAX, 0);
    fixes.clampInteger('length', 1, TICK_MAX, DEFAULT_CLIP_LENGTH_TICKS);
    if (kind === 'audio') repairAudioClipFields(clip, fixes, project.samples as JsonObject);
    else fixes.clampInteger('offset', 0, TICK_MAX, 0);
    fixes.dropIfInvalid('muted', isBoolean);
    fixes.dropIfInvalid('name', isString);
    fixes.dropIfInvalid('color', isString);
    if (fixes.changed) log.count('clip-fields', (n) => `Fixed ${countOf(n, CLIP)} with an invalid position or length.`);
  }
}

/** True when the clip's pattern (or audio/automation channel of the right kind) and its track exist. */
function clipPointsAtExistingThings(clip: JsonObject, project: JsonObject): boolean {
  const lanes = (project.playlist as JsonObject).lanes as JsonObject;
  const hasLane = isString(clip.laneId) && hasOwn(lanes, clip.laneId);
  return hasLane && clipSourceExists(clip, project);
}

function clipSourceExists(clip: JsonObject, project: JsonObject): boolean {
  if (clip.kind === 'pattern') {
    return isString(clip.patternId) && hasOwn(project.patterns as JsonObject, clip.patternId);
  }
  const channels = project.channels as JsonObject;
  const channelKind = clip.kind === 'audio' ? 'audioClip' : 'automation';
  return (
    isString(clip.channelId) &&
    hasOwn(channels, clip.channelId) &&
    (channels[clip.channelId] as JsonObject).kind === channelKind
  );
}

function repairAudioClipFields(clip: JsonObject, fixes: FieldRepairs, samples: JsonObject): void {
  fixes.clamp('offsetSec', 0, Number.MAX_VALUE, 0);
  fixes.clampIfSet('gain', 0, CLIP_GAIN_MAX, 1);
  fixes.clampIfSet('fadeIn', 0, CLIP_FADE_MAX_SEC, 0);
  fixes.clampIfSet('fadeOut', 0, CLIP_FADE_MAX_SEC, 0);
  if (isSet(clip, 'pitchEdit')) fixes.noteChange(repairPitchEdit(clip, samples));
}

/**
 * Pitch correction: the edit is cleaned; a render that is not in the samples is forgotten. True when
 * anything was changed.
 */
function repairPitchEdit(clip: JsonObject, samples: JsonObject): boolean {
  const original = clip.pitchEdit;
  const noteCountBefore = isObject(original) && Array.isArray(original.notes) ? original.notes.length : -1;
  const edit = sanitizePitchEdit(original);
  if (!edit) {
    delete clip.pitchEdit;
    return true;
  }
  let wasFixed = edit.notes.length !== noteCountBefore;
  if (edit.renderedSampleId && !hasOwn(samples, edit.renderedSampleId)) {
    delete edit.renderedSampleId;
    delete edit.renderedFor;
    wasFixed = true;
  }
  clip.pitchEdit = edit;
  return wasFixed;
}

function repairMarkers(playlist: JsonObject, log: RepairLog): void {
  const markers = playlist.markers as JsonObject;
  repairRecords(markers, MARKER, log);
  for (const entry of Object.values(markers)) {
    const marker = entry as JsonObject;
    const fixes = new FieldRepairs(marker);
    fixes.clampInteger('tick', 0, TICK_MAX, 0);
    fixes.require('name', isString, 'Marker');
    if ((marker.name as string).length > MARKER_NAME_MAX_LENGTH) {
      marker.name = (marker.name as string).slice(0, MARKER_NAME_MAX_LENGTH);
      fixes.noteChange(true);
    }
    fixes.dropIfInvalid('color', isString);
    if (fixes.changed)
      log.count('marker-fields', (n) => `Fixed ${countOf(n, MARKER)} with an invalid position or name.`);
  }
  log.flush();
}
