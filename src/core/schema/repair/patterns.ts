/** Repair of patterns and the notes inside them. */
import { DEFAULT_ROOT_KEY, makePattern, paletteColor } from '../../model/defaults';
import { type RepairLog, CHANNEL, NOTE, PATTERN, countOf, noun } from './log';
import { TICK_MAX } from './limits';
import { FieldRepairs } from './fields';
import { repairOrder, repairRecords } from './records';
import { repairVariants } from './variants';
import { hasOwn, isBoolean, isObject, isPositiveInteger, isString, type JsonObject } from '../json-values';

/** The most steps a pattern may have. */
const STEP_COUNT_MAX = 512;
const DEFAULT_STEP_COUNT = 16;
/** A note length that is not a number becomes one 1/16 step (240 ticks at 960 per beat). */
const DEFAULT_NOTE_LENGTH_TICKS = 240;
/** MIDI velocity 100 of 128, the usual default of a new note. */
const DEFAULT_NOTE_VELOCITY = 100 / 128;
const MIDI_KEY_MAX = 127;
/** The widest fine-tune of a single note, in cents (a semitone each way). */
const NOTE_FINE_CENTS_MAX = 100;
const DEFAULT_NOTE_RELEASE = 0.5;

/**
 * Repairs every pattern's settings and notes, turns broken variants into ordinary patterns, repairs the
 * pattern list, and makes sure the project has at least one pattern.
 */
export function repairPatterns(project: JsonObject, log: RepairLog): void {
  const patterns = project.patterns as JsonObject;
  const channels = project.channels as JsonObject;
  const knownIds = repairRecords(patterns, PATTERN, log);

  Object.values(patterns).forEach((entry, index) => {
    const pattern = entry as JsonObject;
    repairPatternSettings(pattern, index, log);
    repairNoteMaps(pattern.notes as JsonObject, channels, log);
  });
  log.flush();
  repairVariants(patterns, log);

  project.patternOrder = repairOrder(
    project.patternOrder as unknown[],
    patterns,
    knownIds,
    'pattern list',
    PATTERN,
    log,
  );
  if ((project.patternOrder as string[]).length === 0) {
    const pattern = makePattern('Pattern 1', paletteColor(0));
    patterns[pattern.id] = pattern;
    project.patternOrder = [pattern.id];
    log.add('Added an empty pattern because the project had none.');
  }
}

/** Name, colour, step count, length and the notes table of one pattern (`index` counts from 0). */
function repairPatternSettings(pattern: JsonObject, index: number, log: RepairLog): void {
  const fixes = new FieldRepairs(pattern);
  fixes.require('name', isString, `Pattern ${index + 1}`);
  fixes.require('color', isString, paletteColor(index));
  fixes.clampInteger('stepCount', 1, STEP_COUNT_MAX, DEFAULT_STEP_COUNT);
  fixes.dropIfInvalid('length', isPositiveInteger);
  fixes.require('notes', isObject, {});
  if (fixes.changed) log.count('pat-fields', (n) => `Fixed ${countOf(n, PATTERN)} with invalid settings.`);
}

/** Drops the notes of channels that are gone, and repairs each note that is left. */
function repairNoteMaps(notesByChannel: JsonObject, channels: JsonObject, log: RepairLog): void {
  for (const channelId of Object.keys(notesByChannel)) {
    const notes = notesByChannel[channelId];
    if (!hasOwn(channels, channelId) || !isObject(notes)) {
      delete notesByChannel[channelId];
      log.count('note-maps', (n) => `Removed notes for ${countOf(n, CHANNEL)} that no longer exist.`);
      continue;
    }
    repairRecords(notes, NOTE, log);
    for (const note of Object.values(notes)) repairNote(note as JsonObject, log);
  }
}

function repairNote(note: JsonObject, log: RepairLog): void {
  const fixes = new FieldRepairs(note);
  fixes.clampInteger('tick', 0, TICK_MAX, 0);
  fixes.clampInteger('length', 1, TICK_MAX, DEFAULT_NOTE_LENGTH_TICKS);
  fixes.clampInteger('key', 0, MIDI_KEY_MAX, DEFAULT_ROOT_KEY);
  fixes.clampIfSet('pan', -1, 1, 0);
  fixes.clampIfSet('release', 0, 1, DEFAULT_NOTE_RELEASE);
  fixes.clampIfSet('fine', -NOTE_FINE_CENTS_MAX, NOTE_FINE_CENTS_MAX, 0);
  fixes.dropIfInvalid('muted', isBoolean);
  if (fixes.changed)
    log.count('note-fields', (n) => `Fixed ${countOf(n, NOTE)} with an invalid position, length or key.`);

  const velocity = new FieldRepairs(note);
  velocity.clamp('velocity', 0, 1, DEFAULT_NOTE_VELOCITY);
  if (velocity.changed) {
    log.count('velocity', (n) => `Clamped ${countOf(n, noun('note velocity', 'note velocities'))} into 0–1.`);
  }
}
