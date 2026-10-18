/** Repair of the DJ mix the auto-mix wrote into the project (`Project.dj`, optional). */
import { type RepairLog } from './log';
import { FieldRepairs } from './fields';
import { hasOwn, isBoolean, isFiniteNumber, isObject, isSet, isString, type JsonObject } from '../json-values';

/** The allowed values of each DJ mix option, and what a damaged option goes back to. */
const DJ_OPTIONS = {
  order: ['keep', 'auto'],
  energy: ['build', 'party', 'chill', 'peak-time'],
  transition: ['auto', 'smooth', 'quick', 'cut'],
} as const;
const DJ_OPTION_DEFAULTS: Record<keyof typeof DJ_OPTIONS, string> = {
  order: 'auto',
  energy: 'party',
  transition: 'auto',
};
/** A fixed mix tempo must be a sensible BPM for dance music (or the text 'follow'). */
const MIX_TEMPO_MIN_BPM = 50;
const MIX_TEMPO_MAX_BPM = 250;

/**
 * The DJ mix: its songs must be samples of the project; what it made is filtered to what still exists;
 * broken options go back to the defaults. A mix without songs goes.
 */
export function repairDj(project: JsonObject, log: RepairLog): void {
  if (!isSet(project, 'dj')) return;
  const dj = project.dj;
  const samples = isObject(project.samples) ? project.samples : {};
  if (!isObject(dj) || !Array.isArray(dj.songs)) {
    delete project.dj;
    log.add('Forgot the damaged DJ mix details (the songs stay on the playlist).');
    return;
  }
  const songs = dj.songs.filter((song): song is JsonObject => isUsableSong(song, samples));
  if (songs.length === 0) {
    delete project.dj;
    log.add('Forgot the DJ mix details: its songs are gone.');
    return;
  }
  let wasFixed = songs.length !== dj.songs.length;
  for (const song of songs) wasFixed = repairSong(song) || wasFixed;
  dj.songs = songs;
  wasFixed = repairOptions(dj) || wasFixed;
  if (!isObject(dj.tweaks)) {
    dj.tweaks = {};
    wasFixed = true;
  }
  forgetMissingMadeThings(dj, project);
  if (wasFixed) log.add('Fixed damaged DJ mix details.');
}

/** A song needs a sample of the project, a title and a start and end tick. */
function isUsableSong(song: unknown, samples: JsonObject): boolean {
  return (
    isObject(song) &&
    isString(song.sampleId) &&
    hasOwn(samples, song.sampleId) &&
    isString(song.title) &&
    isFiniteNumber(song.start) &&
    isFiniteNumber(song.end)
  );
}

/** Tempo, key and deck of one song go back to "unknown" / deck A when damaged. True when anything changed. */
function repairSong(song: JsonObject): boolean {
  const fixes = new FieldRepairs(song);
  fixes.require('bpm', (v) => v === null || isFiniteNumber(v), null);
  fixes.require('camelot', (v) => v === null || isString(v), null);
  fixes.require('deck', (v) => v === 'A' || v === 'B', 'A');
  fixes.dropIfInvalid('pinned', isBoolean);
  return fixes.changed;
}

/** Puts every option into its allowed values (creating `options` when missing, which is not a fix). */
function repairOptions(dj: JsonObject): boolean {
  if (!isObject(dj.options)) dj.options = {};
  const options = dj.options as JsonObject;
  const fixes = new FieldRepairs(options);
  for (const [key, allowed] of Object.entries(DJ_OPTIONS)) {
    fixes.require(
      key,
      (v) => (allowed as readonly unknown[]).includes(v),
      DJ_OPTION_DEFAULTS[key as keyof typeof DJ_OPTIONS],
    );
  }
  fixes.require(
    'mixTempo',
    (v) => v === 'follow' || (isFiniteNumber(v) && v >= MIX_TEMPO_MIN_BPM && v <= MIX_TEMPO_MAX_BPM),
    'follow',
  );
  fixes.dropIfInvalid('lengthTargetMin', (v) => isFiniteNumber(v) && v > 0);
  fixes.dropIfInvalid('keyLock', isBoolean);
  return fixes.changed;
}

/** `made` lists the channels and markers the mix created: keeps only those that still exist. */
function forgetMissingMadeThings(dj: JsonObject, project: JsonObject): void {
  if (!isObject(dj.made)) dj.made = {};
  const made = dj.made as JsonObject;
  const channels = isObject(project.channels) ? project.channels : {};
  const markers = isObject(project.playlist) && isObject(project.playlist.markers) ? project.playlist.markers : {};
  made.channels = idsThatExist(made.channels, channels);
  made.markers = idsThatExist(made.markers, markers);
}

function idsThatExist(ids: unknown, records: JsonObject): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => isString(id) && hasOwn(records, id));
}
