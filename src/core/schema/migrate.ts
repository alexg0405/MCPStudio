/**
 * Project schema upgrades and repair.
 *
 * - `migrateProject` checks the version, runs `migrations[n]` (untyped JSON, schema n → n + 1) up to
 *   SCHEMA_VERSION and validates the structure (every container present with the right type).
 * - `repairProject` fixes the content: dangling references, order arrays, out-of-range values. It
 *   never throws on a structurally valid project and reports each kind of fix in plain words.
 *
 * Bumping SCHEMA_VERSION: append a migration here and add a fixture in test/fixtures/projects/.
 */
import {
  DEFAULT_BPM,
  DEFAULT_CHANNEL_VOLUME,
  DEFAULT_ROOT_KEY,
  makeInsert,
  makePattern,
  paletteColor,
} from '../model/defaults';
import { isSha256Hex } from '../io/hash';
import { newId } from '../model/ids';
import { MASTER, SCHEMA_VERSION, type Project } from '../model/types';

/** A project as parsed from JSON, before it is known to match the current types. */
export type UntypedProject = Record<string, unknown>;
/** Upgrades a schema-n project to schema n + 1 (it may mutate and return its argument). */
export type Migration = (project: UntypedProject) => UntypedProject;

/** `MIGRATIONS[n]` upgrades schema n to n + 1. Schema 1 is the first version, so the list is empty. */
export const MIGRATIONS: readonly (Migration | undefined)[] = [];

export type SchemaErrorCode = 'invalid' | 'too-new' | 'too-old';

export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  /** The schemaVersion found in the data, when known. */
  readonly version?: number;
  constructor(code: SchemaErrorCode, message: string, opts: { version?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SchemaError';
    this.code = code;
    if (opts.version !== undefined) this.version = opts.version;
  }
}

/** Channel volume is linear gain 0–1.25 (see setChannelProp). */
export const CHANNEL_VOLUME_MAX = 1.25;
/** Insert faders are linear gain; the ceiling (+12 dB) is generous so repair only catches nonsense. */
export const INSERT_VOLUME_MAX = 4;
export const BPM_MIN = 10;
export const BPM_MAX = 522;
const STEP_COUNT_MAX = 512;
const TIME_SIG_DENOMINATORS = [1, 2, 4, 8, 16, 32];
const DEFAULT_VELOCITY = 100 / 128;
const DEFAULT_NOTE_LENGTH = 240;
const DEFAULT_CLIP_LENGTH = 3840;

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, key: string) => Object.hasOwn(o, key);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

// ---------------------------------------------------------------------------------------------
// Migration

const SHAPE: readonly [path: readonly string[], kind: 'object' | 'array'][] = [
  [['meta'], 'object'],
  [['transport'], 'object'],
  [['channels'], 'object'],
  [['channelOrder'], 'array'],
  [['patterns'], 'object'],
  [['patternOrder'], 'array'],
  [['playlist'], 'object'],
  [['playlist', 'lanes'], 'object'],
  [['playlist', 'laneOrder'], 'array'],
  [['playlist', 'clips'], 'object'],
  [['mixer'], 'object'],
  [['mixer', 'inserts'], 'object'],
  [['mixer', 'order'], 'array'],
  [['samples'], 'object'],
];

/**
 * Upgrades parsed project JSON to the current schema and checks its structure. Throws a SchemaError
 * for data that is not a project, comes from a newer version, or has no migration path. The input
 * is never mutated (migrations run on a copy); without migrations the input object is returned.
 */
export function migrateProject(
  json: unknown,
  migrations: readonly (Migration | undefined)[] = MIGRATIONS,
): { project: Project; migratedFrom: number } {
  if (!isObject(json)) throw new SchemaError('invalid', 'The project data is not an object.');
  const from = json.schemaVersion;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
    throw new SchemaError('invalid', 'The project data has no valid schemaVersion.');
  }
  if (from > SCHEMA_VERSION) {
    throw new SchemaError(
      'too-new',
      `The project uses schema version ${from}; this version of AGstudio reads up to ${SCHEMA_VERSION}.`,
      { version: from },
    );
  }
  let current: UntypedProject = json;
  if (from < SCHEMA_VERSION) {
    current = JSON.parse(JSON.stringify(json)) as UntypedProject;
    for (let v = from; v < SCHEMA_VERSION; v++) {
      const migrate = migrations[v];
      if (!migrate) {
        throw new SchemaError('too-old', `There is no upgrade from project schema version ${v}.`, { version: from });
      }
      let next: unknown;
      try {
        next = migrate(current);
      } catch (cause) {
        throw new SchemaError('invalid', `Upgrading the project from schema version ${v} failed.`, {
          version: from,
          cause,
        });
      }
      if (!isObject(next)) {
        throw new SchemaError('invalid', `Upgrading from schema version ${v} produced no project.`, { version: from });
      }
      next.schemaVersion = v + 1;
      current = next;
    }
  }
  for (const [path, kind] of SHAPE) {
    let node: unknown = current;
    for (const key of path) node = isObject(node) && has(node, key) ? node[key] : undefined;
    const ok = kind === 'array' ? Array.isArray(node) : isObject(node);
    if (!ok) throw new SchemaError('invalid', `The project data has no valid "${path.join('.')}" ${kind}.`);
  }
  return { project: current as unknown as Project, migratedFrom: from };
}

// ---------------------------------------------------------------------------------------------
// Repair

type Noun = readonly [one: string, many: string];
const noun = (one: string, many = `${one}s`): Noun => [one, many];
const count = (n: number, [one, many]: Noun) => `${n} ${n === 1 ? one : many}`;
const prefixed = (prefix: string, [one, many]: Noun): Noun => [`${prefix} ${one}`, `${prefix} ${many}`];

const SAMPLE = noun('sample entry', 'sample entries');
const INSERT = noun('mixer track');
const CHANNEL = noun('channel');
const PATTERN = noun('pattern');
const NOTE = noun('note');
const LANE = noun('playlist track');
const CLIP = noun('playlist clip');
const SLOT = noun('effect slot');

/** Collects fixes; counted fixes become one message per kind (in first-seen order). */
class RepairLog {
  readonly messages: string[] = [];
  private readonly counts = new Map<string, { n: number; format: (n: number) => string }>();

  add(message: string): void {
    this.flush();
    this.messages.push(message);
  }

  count(key: string, format: (n: number) => string): void {
    const entry = this.counts.get(key);
    if (entry) entry.n++;
    else this.counts.set(key, { n: 1, format });
  }

  /** Emits the counted messages; called after each section so messages keep a logical order. */
  flush(): void {
    for (const { n, format } of this.counts.values()) this.messages.push(format(n));
    this.counts.clear();
  }
}

/**
 * Drops entries that are not objects (or have an unsafe key) and makes each record's `id` match its
 * key. Returns the keys present before repair, so order arrays can drop removed ids silently.
 */
function repairRecords(records: Obj, what: Noun, log: RepairLog): ReadonlySet<string> {
  const original = new Set(Object.keys(records));
  for (const key of original) {
    const value = records[key];
    if (key === '__proto__' || !isObject(value)) {
      delete records[key];
      log.count(`damaged ${what[0]}`, (n) => `Removed ${count(n, prefixed('damaged', what))}.`);
    } else if (value.id !== key) {
      value.id = key;
      log.count(`id ${what[0]}`, (n) => `Fixed ${count(n, what)} stored under the wrong id.`);
    }
  }
  return original;
}

/**
 * Keeps each existing id once, in order, then appends records the order array forgot. Ids of records
 * removed during this repair (`known` but gone) are dropped without another message.
 */
function repairOrder(
  order: readonly unknown[],
  records: Obj,
  known: ReadonlySet<string>,
  label: string,
  what: Noun,
  log: RepairLog,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let unknown = 0;
  let duplicates = 0;
  for (const id of order) {
    if (!isString(id) || !has(records, id)) {
      if (!isString(id) || !known.has(id)) unknown++;
    } else if (seen.has(id)) duplicates++;
    else {
      seen.add(id);
      out.push(id);
    }
  }
  const missing = Object.keys(records).filter((id) => !seen.has(id));
  out.push(...missing);
  if (unknown) log.add(`Removed ${count(unknown, noun('unknown entry', 'unknown entries'))} from the ${label}.`);
  if (duplicates)
    log.add(`Removed ${count(duplicates, noun('duplicate entry', 'duplicate entries'))} from the ${label}.`);
  if (missing.length) log.add(`Added ${count(missing.length, what)} missing from the ${label}.`);
  return out;
}

/** Clamps a numeric field (non-numbers get `fallback`). Returns true when the value changed. */
function clampField(o: Obj, key: string, lo: number, hi: number, fallback: number, integer = false): boolean {
  const v = o[key];
  let next = isFiniteNumber(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  if (integer) next = Math.round(next);
  if (Object.is(next, v)) return false;
  o[key] = next;
  return true;
}

/** Replaces a required field of the wrong type. Returns true when it did. */
function requireField(o: Obj, key: string, valid: (v: unknown) => boolean, fallback: unknown): boolean {
  if (valid(o[key])) return false;
  o[key] = fallback;
  return true;
}

/** Deletes an optional field that is present with the wrong type. Returns true when it did. */
function optionalField(o: Obj, key: string, valid: (v: unknown) => boolean): boolean {
  if (!has(o, key) || o[key] === undefined || valid(o[key])) return false;
  delete o[key];
  return true;
}

const isParamValue = (v: unknown) => isString(v) || isBoolean(v) || isFiniteNumber(v);

/** Sanitizes a plugin instance in place; false when it is unusable (no plugin id). */
function repairPlugin(plugin: unknown, samples: Obj, log: RepairLog): boolean {
  if (!isObject(plugin) || !isString(plugin.pluginId) || plugin.pluginId === '') return false;
  let fixed = requireField(plugin, 'pluginVersion', isFiniteNumber, 1);
  if (!isObject(plugin.params)) {
    plugin.params = {};
    fixed = true;
  } else {
    for (const [k, v] of Object.entries(plugin.params)) {
      if (isParamValue(v)) continue;
      delete plugin.params[k];
      fixed = true;
    }
  }
  if (has(plugin, 'samples') && plugin.samples !== undefined) {
    if (!isObject(plugin.samples)) {
      delete plugin.samples;
      fixed = true;
    } else {
      for (const [slot, id] of Object.entries(plugin.samples)) {
        if (isString(id) && has(samples, id)) continue;
        delete plugin.samples[slot];
        log.count('sample-ref', (n) => `Removed ${count(n, noun('reference'))} to missing samples.`);
      }
    }
  }
  if (fixed) log.count('plugin', (n) => `Fixed damaged settings in ${count(n, noun('plugin'))}.`);
  return true;
}

function repairMeta(p: Obj, log: RepairLog): void {
  if (!isString(p.projectId) || p.projectId === '') {
    p.projectId = newId.project();
    log.add('Gave the project a new id because it had none.');
  }
  const meta = p.meta as Obj;
  const fixed: string[] = [];
  if (requireField(meta, 'title', isString, 'Untitled')) fixed.push('title');
  if (requireField(meta, 'createdAt', isString, new Date(0).toISOString())) fixed.push('creation date');
  if (requireField(meta, 'appVersion', isString, 'unknown')) fixed.push('app version');
  if (optionalField(meta, 'author', isString)) fixed.push('author');
  if (fixed.length) log.add(`Reset damaged project details (${fixed.join(', ')}).`);
}

function repairTransport(p: Obj, log: RepairLog): void {
  const t = p.transport as Obj;
  const bpm = t.bpm;
  if (!isFiniteNumber(bpm)) {
    t.bpm = DEFAULT_BPM;
    log.add(`The tempo was invalid and was reset to ${DEFAULT_BPM} BPM.`);
  } else if (bpm < BPM_MIN || bpm > BPM_MAX) {
    t.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
    log.add(`The tempo (${bpm} BPM) was out of range and was set to ${t.bpm as number} BPM.`);
  }
  const sig = t.timeSig;
  const sigOk =
    isObject(sig) &&
    Number.isInteger(sig.num) &&
    (sig.num as number) >= 1 &&
    (sig.num as number) <= 32 &&
    TIME_SIG_DENOMINATORS.includes(sig.den as number);
  if (!sigOk) {
    t.timeSig = { num: 4, den: 4 };
    log.add('The time signature was invalid and was reset to 4/4.');
  }
  if (clampField(t, 'swing', 0, 1, 0))
    log.add(`The swing amount was out of range and was set to ${t.swing as number}.`);
}

function repairSamples(p: Obj, log: RepairLog): void {
  const samples = p.samples as Obj;
  repairRecords(samples, SAMPLE, log);
  const detailsFixed = () => log.count('sample-fields', (n) => `Fixed ${count(n, SAMPLE)} with invalid details.`);
  for (const [id, raw] of Object.entries(samples)) {
    const s = raw as Obj;
    const src = s.source;
    let valid = false;
    if (isObject(src) && src.kind === 'builtin') {
      valid = isString(src.generator) && isFiniteNumber(src.version);
    } else if (isObject(src) && src.kind === 'embedded' && isString(src.hash) && isString(src.ext)) {
      const hash = src.hash.toLowerCase();
      valid = isSha256Hex(hash);
      if (valid && hash !== src.hash) {
        src.hash = hash;
        detailsFixed();
      }
      if (valid && optionalField(src, 'originalName', isString)) detailsFixed();
    }
    if (!valid) {
      delete samples[id];
      log.count('sample-source', (n) => `Removed ${count(n, SAMPLE)} with no usable source.`);
      continue;
    }
    let fixed = requireField(s, 'name', isString, 'Sample');
    fixed = optionalField(s, 'durationSec', (v) => isFiniteNumber(v) && v >= 0) || fixed;
    fixed = optionalField(s, 'sampleRate', (v) => isFiniteNumber(v) && v > 0) || fixed;
    fixed = optionalField(s, 'channels', (v) => Number.isInteger(v) && (v as number) > 0) || fixed;
    if (fixed) detailsFixed();
  }
  log.flush();
}

function repairMixer(p: Obj, log: RepairLog): void {
  const mixer = p.mixer as Obj;
  const inserts = mixer.inserts as Obj;
  const samples = p.samples as Obj;
  const known = repairRecords(inserts, INSERT, log);
  let order = mixer.order as unknown[];
  if (!has(inserts, MASTER)) {
    inserts[MASTER] = makeInsert(MASTER, 'Master');
    order = [MASTER, ...order.filter((id) => id !== MASTER)];
    log.add('Added the missing Master mixer track.');
  }
  let ids = repairOrder(order, inserts, known, 'mixer track list', INSERT, log);
  if (ids[0] !== MASTER) {
    ids = [MASTER, ...ids.filter((id) => id !== MASTER)];
    log.add('Moved the Master track to the first mixer slot.');
  }
  mixer.order = ids;

  ids.forEach((id, index) => {
    const ins = inserts[id] as Obj;
    let fixed = requireField(ins, 'name', isString, id === MASTER ? 'Master' : `Insert ${index}`);
    fixed = requireField(ins, 'muted', isBoolean, false) || fixed;
    fixed = requireField(ins, 'solo', isBoolean, false) || fixed;
    fixed = optionalField(ins, 'color', isString) || fixed;
    if (fixed) log.count('insert-fields', (n) => `Fixed ${count(n, INSERT)} with invalid settings.`);
    let clamped = clampField(ins, 'volume', 0, INSERT_VOLUME_MAX, 1);
    clamped = clampField(ins, 'pan', -1, 1, 0) || clamped;
    if (clamped) log.count('level', (n) => `Clamped ${count(n, noun('volume or pan setting'))} into range.`);

    const damagedSlot = () => log.count('fx-damaged', (n) => `Removed ${count(n, prefixed('damaged', SLOT))}.`);
    if (!Array.isArray(ins.fx)) {
      ins.fx = [];
      damagedSlot();
      return;
    }
    const slotIds = new Set<string>();
    ins.fx = (ins.fx as unknown[]).filter((slot) => {
      if (!isObject(slot) || !repairPlugin(slot.plugin, samples, log)) {
        damagedSlot();
        return false;
      }
      if (!isString(slot.id) || slot.id === '' || slotIds.has(slot.id)) {
        slot.id = newId.slot();
        log.count('fx-id', (n) => `Gave ${count(n, SLOT)} a new id (missing or duplicate).`);
      }
      slotIds.add(slot.id as string);
      let slotFixed = requireField(slot, 'enabled', isBoolean, true);
      slotFixed = clampField(slot, 'mix', 0, 1, 1) || slotFixed;
      if (slotFixed) log.count('fx-fields', (n) => `Fixed ${count(n, SLOT)} with invalid settings.`);
      return true;
    });
  });
  log.flush();
}

function describeChannels(names: readonly string[]): string {
  const quoted = names.slice(0, 3).map((n) => `"${n}"`);
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return names.length === 1 ? `channel ${quoted[0]}` : `${names.length} channels (${quoted.join(', ')}${more})`;
}

function repairChannels(p: Obj, log: RepairLog): void {
  const channels = p.channels as Obj;
  const inserts = (p.mixer as Obj).inserts as Obj;
  const samples = p.samples as Obj;
  const known = repairRecords(channels, CHANNEL, log);
  const rerouted: string[] = [];
  for (const [id, raw] of Object.entries(channels)) {
    const ch = raw as Obj;
    const kind = ch.kind;
    if (kind !== 'instrument' && kind !== 'audioClip' && kind !== 'automation') {
      delete channels[id];
      log.count('ch-kind', (n) => `Removed ${count(n, CHANNEL)} of an unknown type.`);
      continue;
    }
    if (kind === 'instrument' && !repairPlugin(ch.plugin, samples, log)) {
      delete channels[id];
      log.count('ch-plugin', (n) => `Removed ${count(n, CHANNEL)} whose instrument data was missing.`);
      continue;
    }
    if (kind === 'audioClip' && !(isString(ch.sampleId) && has(samples, ch.sampleId))) {
      // Nothing can play without the sample entry; its clips go too (as orphans, in repairPlaylist).
      delete channels[id];
      log.count('ch-sample', (n) => `Removed ${count(n, noun('audio clip channel'))} whose sample entry is missing.`);
      continue;
    }
    let fixed = requireField(ch, 'name', isString, 'Channel');
    fixed = requireField(ch, 'color', isString, paletteColor(0)) || fixed;
    fixed = requireField(ch, 'muted', isBoolean, false) || fixed;
    fixed = requireField(ch, 'solo', isBoolean, false) || fixed;
    if (kind === 'instrument') fixed = clampField(ch, 'rootKey', 0, 127, DEFAULT_ROOT_KEY, true) || fixed;
    if (kind === 'automation') {
      fixed = requireField(ch, 'target', (v) => v === null || isObject(v), null) || fixed;
      if (!Array.isArray(ch.points)) {
        ch.points = [];
        fixed = true;
      } else {
        const points = (ch.points as unknown[]).filter(isObject);
        if (points.length !== (ch.points as unknown[]).length) fixed = true;
        for (const pt of points) {
          fixed = clampField(pt, 'tick', 0, Number.MAX_SAFE_INTEGER, 0, true) || fixed;
          fixed = clampField(pt, 'value', 0, 1, 0) || fixed;
        }
        ch.points = points;
      }
    } else {
      let clamped = clampField(ch, 'volume', 0, CHANNEL_VOLUME_MAX, DEFAULT_CHANNEL_VOLUME);
      clamped = clampField(ch, 'pan', -1, 1, 0) || clamped;
      if (clamped) log.count('level', (n) => `Clamped ${count(n, noun('volume or pan setting'))} into range.`);
      if (!isString(ch.output) || !has(inserts, ch.output)) {
        ch.output = MASTER;
        rerouted.push(ch.name as string);
      }
    }
    if (fixed) log.count('ch-fields', (n) => `Fixed ${count(n, CHANNEL)} with invalid settings.`);
  }
  log.flush();
  if (rerouted.length) {
    const why = rerouted.length === 1 ? 'its mixer track no longer exists' : 'their mixer tracks no longer exist';
    log.add(`Routed ${describeChannels(rerouted)} to the Master track because ${why}.`);
  }
  p.channelOrder = repairOrder(p.channelOrder as unknown[], channels, known, 'channel list', CHANNEL, log);
}

function repairNote(note: Obj, log: RepairLog): void {
  let fixed = clampField(note, 'tick', 0, Number.MAX_SAFE_INTEGER, 0, true);
  fixed = clampField(note, 'length', 1, Number.MAX_SAFE_INTEGER, DEFAULT_NOTE_LENGTH, true) || fixed;
  fixed = clampField(note, 'key', 0, 127, DEFAULT_ROOT_KEY, true) || fixed;
  if (has(note, 'pan') && note.pan !== undefined) fixed = clampField(note, 'pan', -1, 1, 0) || fixed;
  fixed = optionalField(note, 'muted', isBoolean) || fixed;
  if (fixed) log.count('note-fields', (n) => `Fixed ${count(n, NOTE)} with an invalid position, length or key.`);
  if (clampField(note, 'velocity', 0, 1, DEFAULT_VELOCITY)) {
    log.count('velocity', (n) => `Clamped ${count(n, noun('note velocity', 'note velocities'))} into 0–1.`);
  }
}

function repairPatterns(p: Obj, log: RepairLog): void {
  const patterns = p.patterns as Obj;
  const channels = p.channels as Obj;
  const known = repairRecords(patterns, PATTERN, log);
  let index = 0;
  for (const raw of Object.values(patterns)) {
    const pat = raw as Obj;
    index++;
    let fixed = requireField(pat, 'name', isString, `Pattern ${index}`);
    fixed = requireField(pat, 'color', isString, paletteColor(index - 1)) || fixed;
    fixed = clampField(pat, 'stepCount', 1, STEP_COUNT_MAX, 16, true) || fixed;
    fixed = optionalField(pat, 'length', (v) => Number.isInteger(v) && (v as number) >= 1) || fixed;
    fixed = requireField(pat, 'notes', isObject, {}) || fixed;
    if (fixed) log.count('pat-fields', (n) => `Fixed ${count(n, PATTERN)} with invalid settings.`);
    const notes = pat.notes as Obj;
    for (const channelId of Object.keys(notes)) {
      const map = notes[channelId];
      if (!has(channels, channelId) || !isObject(map)) {
        delete notes[channelId];
        log.count('note-maps', (n) => `Removed notes for ${count(n, CHANNEL)} that no longer exist.`);
        continue;
      }
      repairRecords(map, NOTE, log);
      for (const note of Object.values(map)) repairNote(note as Obj, log);
    }
  }
  log.flush();
  p.patternOrder = repairOrder(p.patternOrder as unknown[], patterns, known, 'pattern list', PATTERN, log);
  if ((p.patternOrder as string[]).length === 0) {
    const pattern = makePattern('Pattern 1', paletteColor(0));
    patterns[pattern.id] = pattern;
    p.patternOrder = [pattern.id];
    log.add('Added an empty pattern because the project had none.');
  }
}

function repairPlaylist(p: Obj, log: RepairLog): void {
  const playlist = p.playlist as Obj;
  const lanes = playlist.lanes as Obj;
  const clips = playlist.clips as Obj;
  const patterns = p.patterns as Obj;
  const channels = p.channels as Obj;
  const knownLanes = repairRecords(lanes, LANE, log);
  let index = 0;
  for (const raw of Object.values(lanes)) {
    const lane = raw as Obj;
    index++;
    let fixed = requireField(lane, 'name', isString, `Track ${index}`);
    fixed = requireField(lane, 'muted', isBoolean, false) || fixed;
    fixed = optionalField(lane, 'solo', isBoolean) || fixed;
    fixed = optionalField(lane, 'color', isString) || fixed;
    if (fixed) log.count('lane-fields', (n) => `Fixed ${count(n, LANE)} with invalid settings.`);
  }
  log.flush();
  playlist.laneOrder = repairOrder(
    playlist.laneOrder as unknown[],
    lanes,
    knownLanes,
    'playlist track list',
    LANE,
    log,
  );

  repairRecords(clips, CLIP, log);
  const isChannel = (id: unknown, kind: string) =>
    isString(id) && has(channels, id) && (channels[id] as Obj).kind === kind;
  for (const [id, raw] of Object.entries(clips)) {
    const clip = raw as Obj;
    const kind = clip.kind;
    if (kind !== 'pattern' && kind !== 'audio' && kind !== 'automation') {
      delete clips[id];
      log.count('clip-kind', (n) => `Removed ${count(n, CLIP)} of an unknown type.`);
      continue;
    }
    const target =
      kind === 'pattern'
        ? isString(clip.patternId) && has(patterns, clip.patternId)
        : isChannel(clip.channelId, kind === 'audio' ? 'audioClip' : 'automation');
    if (!target || !isString(clip.laneId) || !has(lanes, clip.laneId)) {
      delete clips[id];
      log.count('clip-orphan', (n) => `Removed ${count(n, CLIP)} whose pattern, channel or track no longer exists.`);
      continue;
    }
    let fixed = clampField(clip, 'start', 0, Number.MAX_SAFE_INTEGER, 0, true);
    fixed = clampField(clip, 'length', 1, Number.MAX_SAFE_INTEGER, DEFAULT_CLIP_LENGTH, true) || fixed;
    if (kind === 'audio') fixed = clampField(clip, 'offsetSec', 0, Number.MAX_VALUE, 0) || fixed;
    else fixed = clampField(clip, 'offset', 0, Number.MAX_SAFE_INTEGER, 0, true) || fixed;
    fixed = optionalField(clip, 'muted', isBoolean) || fixed;
    fixed = optionalField(clip, 'name', isString) || fixed;
    fixed = optionalField(clip, 'color', isString) || fixed;
    if (fixed) log.count('clip-fields', (n) => `Fixed ${count(n, CLIP)} with an invalid position or length.`);
  }
  log.flush();
}

/**
 * Returns a repaired deep copy of a structurally valid project (see migrateProject) and one
 * human-readable line per kind of fix. Never mutates the input. A project that needs no repair comes
 * back deep-equal to the input with no messages, and repairing a repaired project changes nothing.
 */
export function repairProject(project: Project): { project: Project; repairs: string[] } {
  const p = JSON.parse(JSON.stringify(project)) as Obj;
  const log = new RepairLog();
  repairMeta(p, log);
  repairTransport(p, log);
  repairSamples(p, log);
  repairMixer(p, log);
  repairChannels(p, log);
  repairPatterns(p, log);
  repairPlaylist(p, log);
  log.flush();
  return { project: p as unknown as Project, repairs: log.messages };
}
