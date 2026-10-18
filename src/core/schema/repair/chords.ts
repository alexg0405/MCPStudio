/**
 * Repair of the chord track (`Project.chords`, optional): damaged chords are dropped, a bass or confidence out
 * of range is cleared, overlapping chords are trimmed so each ends where the next starts, and an empty track is
 * removed.
 */
import { isQualityId } from '../../harmony/chord';
import { countOf, noun, type RepairLog } from './log';
import { hasOwn, isFiniteNumber, isIntegerBetween, isObject, isSet, type JsonObject } from '../json-values';

/** The most chords the chord track keeps (same as `MAX_CHORDS` in core/ops/chords.ts). */
const MAX_CHORD_TRACK = 4096;
const CHORD = noun('chord');

const isPitchClass = (value: unknown): boolean => isIntegerBetween(value, 0, 11);

/** Whether a stored chord has every field it needs, in range. */
function isValidChord(id: string, chord: unknown): chord is JsonObject {
  return (
    isObject(chord) &&
    chord.id === id &&
    isIntegerBetween(chord.tick, 0, Infinity) &&
    isIntegerBetween(chord.length, 1, Infinity) &&
    isPitchClass(chord.root) &&
    isQualityId(chord.quality)
  );
}

/** Clears an optional field that is out of range (a slash bass that isn't a pitch class, a confidence outside 0–1). */
function clearBadOptionalFields(chord: JsonObject): void {
  if (hasOwn(chord, 'bass') && !isPitchClass(chord.bass)) delete chord.bass;
  const confidenceOk = isFiniteNumber(chord.confidence) && chord.confidence >= 0 && chord.confidence <= 1;
  if (hasOwn(chord, 'confidence') && !confidenceOk) delete chord.confidence;
}

/** Shortens each chord that runs into the next one (chords sorted by tick); returns how many were shortened. */
function trimOverlaps(chordsByTick: JsonObject[]): number {
  let trimmed = 0;
  for (let i = 0; i + 1 < chordsByTick.length; i++) {
    const chord = chordsByTick[i]!;
    const gapToNext = (chordsByTick[i + 1]!.tick as number) - (chord.tick as number);
    if (gapToNext < (chord.length as number)) {
      chord.length = gapToNext;
      trimmed++;
    }
  }
  return trimmed;
}

export function repairChords(project: JsonObject, log: RepairLog): void {
  if (!isSet(project, 'chords')) return;
  if (!isObject(project.chords)) {
    delete project.chords;
    log.add('Forgot the damaged chord track (notes and patterns are not changed).');
    return;
  }
  const kept: JsonObject[] = [];
  let dropped = 0;
  for (const [id, chord] of Object.entries(project.chords)) {
    if (isValidChord(id, chord)) kept.push(chord);
    else dropped++;
  }
  kept.forEach(clearBadOptionalFields);
  kept.sort((a, b) => (a.tick as number) - (b.tick as number));
  if (kept.length > MAX_CHORD_TRACK) {
    dropped += kept.length - MAX_CHORD_TRACK;
    kept.length = MAX_CHORD_TRACK;
  }
  const trimmed = trimOverlaps(kept);
  // A chord squeezed to nothing by one that starts at the same tick is gone.
  const usable = kept.filter((chord) => (chord.length as number) >= 1);
  dropped += kept.length - usable.length;
  if (usable.length === 0) delete project.chords;
  else project.chords = Object.fromEntries(usable.map((chord) => [chord.id as string, chord]));
  if (dropped) log.add(`Dropped ${countOf(dropped, CHORD)} from the chord track that could not be read.`);
  if (trimmed) log.add('Trimmed overlapping chords on the chord track.');
}
