/** Repair of the sample table (`Project.samples`): what each entry points at and its optional details. */
import { isSha256Hex } from '../../io/hash';
import { type RepairLog, SAMPLE, countOf } from './log';
import { FieldRepairs, dropInvalidField } from './fields';
import { repairRecords } from './records';
import { isFiniteNumber, isNonNegativeNumber, isObject, isString, type JsonObject } from '../json-values';

/**
 * Removes entries with no usable source (a built-in generator, or an embedded blob with a SHA-256
 * hash) and fixes the details of the rest: lowercase hashes, a name, and optional duration, sample
 * rate and channel count that must make sense when present.
 */
export function repairSamples(project: JsonObject, log: RepairLog): void {
  const samples = project.samples as JsonObject;
  repairRecords(samples, SAMPLE, log);
  for (const [id, entry] of Object.entries(samples)) {
    const sample = entry as JsonObject;
    const sourceFixes = repairSampleSource(sample.source, log);
    if (sourceFixes === 'unusable') {
      delete samples[id];
      log.count('sample-source', (n) => `Removed ${countOf(n, SAMPLE)} with no usable source.`);
      continue;
    }
    const fixes = new FieldRepairs(sample);
    fixes.require('name', isString, 'Sample');
    fixes.dropIfInvalid('durationSec', isNonNegativeNumber);
    fixes.dropIfInvalid('sampleRate', (v) => isFiniteNumber(v) && v > 0);
    fixes.dropIfInvalid('channels', (v) => Number.isInteger(v) && (v as number) > 0);
    if (fixes.changed) countInvalidDetails(log);
  }
  log.flush();
}

const countInvalidDetails = (log: RepairLog) =>
  log.count('sample-fields', (n) => `Fixed ${countOf(n, SAMPLE)} with invalid details.`);

/** Checks the `source` of a sample entry; fixable details are fixed in place and counted. */
function repairSampleSource(source: unknown, log: RepairLog): 'usable' | 'unusable' {
  if (!isObject(source)) return 'unusable';
  if (source.kind === 'builtin') {
    return isString(source.generator) && isFiniteNumber(source.version) ? 'usable' : 'unusable';
  }
  if (source.kind !== 'embedded' || !isString(source.hash) || !isString(source.ext)) return 'unusable';

  const hash = source.hash.toLowerCase();
  if (!isSha256Hex(hash)) return 'unusable';
  if (hash !== source.hash) {
    source.hash = hash;
    countInvalidDetails(log);
  }
  if (dropInvalidField(source, 'originalName', isString)) countInvalidDetails(log);
  return 'usable';
}
