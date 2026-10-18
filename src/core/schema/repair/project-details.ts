/** Repair of the project's own details: its id, title and dates (`meta`) and the tempo, meter and key (`transport`). */
import { DEFAULT_BPM } from '../../model/defaults';
import { newId } from '../../model/ids';
import { type RepairLog } from './log';
import { BPM_MAX, BPM_MIN } from './limits';
import { clampField, dropInvalidField, requireField } from './fields';
import { isFiniteNumber, isIntegerBetween, isObject, isString, type JsonObject } from '../json-values';

/** The most beats a bar may have in its time signature. */
const TIME_SIGNATURE_NUMERATOR_MAX = 32;
/** The note values a bar may count in: whole, half, quarter, eighth, sixteenth, thirty-second. */
const TIME_SIGNATURE_DENOMINATORS = [1, 2, 4, 8, 16, 32];
const DEFAULT_TIME_SIGNATURE = { num: 4, den: 4 };
/** Pitch classes of a song key's tonic run from 0 (C) to 11 (B). */
const PITCH_CLASS_MAX = 11;

/** Gives the project an id when it has none, and resets damaged title, date, app version and author. */
export function repairMeta(project: JsonObject, log: RepairLog): void {
  if (!isString(project.projectId) || project.projectId === '') {
    project.projectId = newId.project();
    log.add('Gave the project a new id because it had none.');
  }
  const meta = project.meta as JsonObject;
  const resetFields: string[] = [];
  if (requireField(meta, 'title', isString, 'Untitled')) resetFields.push('title');
  if (requireField(meta, 'createdAt', isString, new Date(0).toISOString())) resetFields.push('creation date');
  if (requireField(meta, 'appVersion', isString, 'unknown')) resetFields.push('app version');
  if (dropInvalidField(meta, 'author', isString)) resetFields.push('author');
  if (resetFields.length) log.add(`Reset damaged project details (${resetFields.join(', ')}).`);
}

/** Puts the tempo, time signature, swing and song key back into range. */
export function repairTransport(project: JsonObject, log: RepairLog): void {
  const transport = project.transport as JsonObject;
  repairTempo(transport, log);
  repairTimeSignature(transport, log);
  if (clampField(transport, 'swing', 0, 1, 0)) {
    log.add(`The swing amount was out of range and was set to ${transport.swing as number}.`);
  }
  if (dropInvalidField(transport, 'key', isSongKey)) log.add('The song key was invalid and was cleared.');
}

function repairTempo(transport: JsonObject, log: RepairLog): void {
  const bpm = transport.bpm;
  if (!isFiniteNumber(bpm)) {
    transport.bpm = DEFAULT_BPM;
    log.add(`The tempo was invalid and was reset to ${DEFAULT_BPM} BPM.`);
  } else if (bpm < BPM_MIN || bpm > BPM_MAX) {
    transport.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
    log.add(`The tempo (${bpm} BPM) was out of range and was set to ${transport.bpm as number} BPM.`);
  }
}

function repairTimeSignature(transport: JsonObject, log: RepairLog): void {
  const signature = transport.timeSig;
  const isValid =
    isObject(signature) &&
    isIntegerBetween(signature.num, 1, TIME_SIGNATURE_NUMERATOR_MAX) &&
    TIME_SIGNATURE_DENOMINATORS.includes(signature.den as number);
  if (isValid) return;
  transport.timeSig = { ...DEFAULT_TIME_SIGNATURE };
  log.add('The time signature was invalid and was reset to 4/4.');
}

const isSongKey = (value: unknown): boolean =>
  isObject(value) && isIntegerBetween(value.root, 0, PITCH_CLASS_MAX) && isString(value.scale);
