/**
 * Repair of the reference track (`Project.reference`, optional): only derived measurements of a song the
 * musician owns. Anything that can't be read as a measurement removes it (the song and its sample stay);
 * values are clamped to what they can mean; the sample link is dropped when the sample is gone, but the
 * numbers stay.
 */
import { type RepairLog } from './log';
import { BPM_MAX, BPM_MIN } from './limits';
import { FieldRepairs } from './fields';
import {
  clampNumber,
  hasOwn,
  isFiniteNumber,
  isIntegerBetween,
  isNonNegativeNumber,
  isObject,
  isPositiveInteger,
  isSet,
  isString,
  type JsonObject,
} from '../json-values';

const SECTION_KINDS = ['intro', 'build', 'drop', 'break', 'verse', 'outro', 'body'];
/** The reference's tonal bands (`core/reference/bands.ts`): this many values, in dB under the total. */
const BAND_COUNT = 8;
/** The quietest a band can be, in dB under the total. */
const BAND_FLOOR_DB = -60;
/** The most energy values kept (one per bar of the reference, as the type documents). */
const MAX_ENERGY_VALUES = 1024;
const MAX_SECTIONS = 200;
/** Values for a measurement that was lost: "silent" loudness and true peak, in dB. */
const SILENT_DB = -70;
const DEFAULT_BEATS_PER_BAR = 4;
const MAX_BEATS_PER_BAR = 16;
const DEFAULT_SECTION_ENERGY = 0.5;
const PITCH_CLASS_MAX = 11;

/** A list of exactly the band count of finite dB values (−60…0), or null when it can't be one. */
function clampedBands(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== BAND_COUNT || !value.every(isFiniteNumber)) return null;
  return value.map((band) => clampNumber(band as number, BAND_FLOOR_DB, 0));
}

/** Removes the reference when its core is unreadable; otherwise fixes every measurement in place. */
export function repairReference(project: JsonObject, log: RepairLog): void {
  if (!isSet(project, 'reference')) return;
  const reference = project.reference;
  if (!hasReadableCore(reference)) {
    delete project.reference;
    log.add('Forgot the damaged reference song details (the song itself is not changed).');
    return;
  }
  const fixes = new FieldRepairs(reference);
  fixes.require('title', isString, 'Reference');
  fixes.require('version', isFiniteNumber, 0);
  fixes.noteChange(repairBands(reference));
  fixes.require('bpm', (v) => v === null || (isFiniteNumber(v) && v >= BPM_MIN && v <= BPM_MAX), null);
  fixes.require('beatsPerBar', (v) => isIntegerBetween(v, 1, MAX_BEATS_PER_BAR), DEFAULT_BEATS_PER_BAR);
  fixes.require('lufs', isFiniteNumber, SILENT_DB);
  fixes.require('truePeakDb', isFiniteNumber, SILENT_DB);
  fixes.require('width', isNonNegativeNumber, 0);
  fixes.noteChange(repairKey(reference));
  fixes.noteChange(repairEnergy(reference));
  fixes.noteChange(repairSections(reference));
  fixes.noteChange(dropMissingSample(reference, project));
  if (fixes.changed) log.add('Fixed damaged reference song details.');
}

/** The hash, duration and the lists the other repairs read: without these the numbers mean nothing. */
function hasReadableCore(reference: unknown): reference is JsonObject {
  return (
    isObject(reference) &&
    isString(reference.hash) &&
    isFiniteNumber(reference.durationSec) &&
    Array.isArray(reference.sections) &&
    Array.isArray(reference.energy) &&
    clampedBands(reference.bands) !== null
  );
}

/**
 * Replaces `object.bands` by its clamped copy, or by a flat floor when it is not a band list. True when
 * the stored list changed.
 */
function repairBands(object: JsonObject): boolean {
  const clamped = clampedBands(object.bands);
  if (!clamped) {
    object.bands = new Array<number>(BAND_COUNT).fill(BAND_FLOOR_DB);
    return true;
  }
  const wasClamped = (object.bands as number[]).some((band, i) => band !== clamped[i]);
  object.bands = clamped;
  return wasClamped;
}

/** The key is null (none found) or a root, mode, Camelot code and confidence. True when it was reset. */
function repairKey(reference: JsonObject): boolean {
  const key = reference.key;
  if (key === null || isValidKey(key)) return false;
  reference.key = null;
  return true;
}

function isValidKey(key: unknown): boolean {
  return (
    isObject(key) &&
    isIntegerBetween(key.root, 0, PITCH_CLASS_MAX) &&
    (key.mode === 'major' || key.mode === 'minor') &&
    isString(key.camelot) &&
    isFiniteNumber(key.confidence)
  );
}

/** Keeps the finite energy values (at most one per bar), each in 0–1. True when the list changed. */
function repairEnergy(reference: JsonObject): boolean {
  const original = reference.energy as unknown[];
  const finite = original.filter(isFiniteNumber).slice(0, MAX_ENERGY_VALUES);
  const clamped = finite.map((energy) => clampNumber(energy, 0, 1));
  reference.energy = clamped;
  return clamped.length !== original.length || clamped.some((energy, i) => energy !== finite[i]);
}

/** Keeps the valid sections (at most 200) and fixes their bars, energy, width and bands. */
function repairSections(reference: JsonObject): boolean {
  const original = reference.sections as unknown[];
  const sections = original.filter(isReadableSection);
  let wasFixed = sections.length !== original.length;
  for (const section of sections) wasFixed = repairSection(section) || wasFixed;
  if (sections.length > MAX_SECTIONS) wasFixed = true;
  reference.sections = sections.slice(0, MAX_SECTIONS);
  return wasFixed;
}

/** A section needs a known kind and a span that starts at or after 0 and ends later. */
function isReadableSection(section: unknown): section is JsonObject {
  return (
    isObject(section) &&
    SECTION_KINDS.includes(section.kind as string) &&
    isFiniteNumber(section.startSec) &&
    isFiniteNumber(section.endSec) &&
    section.endSec > section.startSec &&
    section.startSec >= 0
  );
}

function repairSection(section: JsonObject): boolean {
  const spanSec = (section.endSec as number) - (section.startSec as number);
  // Bars count on the reference's own grid, which is 2 s per bar when no tempo was found: a fair guess.
  const guessedBars = Math.max(1, Math.round(spanSec / 2));
  const fixes = new FieldRepairs(section);
  fixes.require('bars', isPositiveInteger, guessedBars);
  fixes.require('energy', (v) => isFiniteNumber(v) && v >= 0 && v <= 1, DEFAULT_SECTION_ENERGY);
  fixes.require('width', isNonNegativeNumber, 0);
  fixes.noteChange(repairBands(section));
  return fixes.changed;
}

/** The link to the reference's sample goes when that sample is gone; the measurements stay. */
function dropMissingSample(reference: JsonObject, project: JsonObject): boolean {
  if (!isSet(reference, 'sampleId')) return false;
  const samples = isObject(project.samples) ? project.samples : {};
  if (isString(reference.sampleId) && hasOwn(samples, reference.sampleId)) return false;
  delete reference.sampleId;
  return true;
}
