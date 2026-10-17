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
  masterRoutes,
  paletteColor,
} from '../model/defaults';
import { sanitizePitchEdit } from '../audio/pitch-edit';
import { isSha256Hex } from '../io/hash';
import { newId } from '../model/ids';
import {
  AUDIO_STRETCH,
  AUTO_SHAPES,
  MASTER,
  SCHEMA_VERSION,
  VARIANT_KINDS,
  type AudioStretch,
  type InsertId,
  type Project,
  type VariantKind,
} from '../model/types';

/** A project as parsed from JSON, before it is known to match the current types. */
export type UntypedProject = Record<string, unknown>;
/** Upgrades a schema-n project to schema n + 1 (it may mutate and return its argument). */
export type Migration = (project: UntypedProject) => UntypedProject;

/**
 * v1 → v2: mixer routing (every insert routes to the master, as v1 did implicitly), effect-slot
 * sidechains (none) and MIDI controller links (none). Tolerates damaged data; repair handles it.
 */
const v1ToV2: Migration = (p) => {
  const mixer = p.mixer;
  if (isObject(mixer) && isObject(mixer.inserts)) {
    for (const [id, ins] of Object.entries(mixer.inserts)) {
      if (!isObject(ins)) continue;
      ins.routes = id === MASTER ? [] : [{ to: MASTER, level: 1, pre: false }];
      if (Array.isArray(ins.fx)) for (const slot of ins.fx) if (isObject(slot)) slot.sidechain = null;
    }
  }
  p.controllers = {};
  return p;
};

/**
 * v2 → v3: playlist markers (none). The new audio-clip edits (gain, fades, pitch, reverse, stretch)
 * are optional, so v2 clips are already valid v3 clips.
 */
const v2ToV3: Migration = (p) => {
  if (isObject(p.playlist)) p.playlist.markers = {};
  return p;
};

/** `MIGRATIONS[n]` upgrades schema n to n + 1. Schema 1 is the first version. */
export const MIGRATIONS: readonly (Migration | undefined)[] = [undefined, v1ToV2, v2ToV3];

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
  [['playlist', 'markers'], 'object'],
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
const ROUTE = noun('mixer route');
const LINK = noun('controller link');
const MARKER = noun('playlist marker');

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
  if (
    optionalField(
      t,
      'key',
      (v) =>
        isObject(v) &&
        Number.isInteger(v.root) &&
        (v.root as number) >= 0 &&
        (v.root as number) <= 11 &&
        isString(v.scale),
    )
  )
    log.add('The song key was invalid and was cleared.');
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

    repairRoutes(ins, id, inserts, log);
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
      if (!(
        slot.sidechain === null ||
        (isString(slot.sidechain) && has(inserts, slot.sidechain) && slot.sidechain !== id)
      )) {
        slot.sidechain = null;
        log.count('fx-sidechain', (n) => `Cleared ${count(n, noun('invalid sidechain input'))}.`);
      }
      return true;
    });
  });
  log.flush();
  breakRoutingCycles(ids, inserts, log);
  log.flush();
}

/** One route per target, to an existing insert other than itself; the master routes nowhere. */
function repairRoutes(ins: Obj, id: string, inserts: Obj, log: RepairLog): void {
  if (!Array.isArray(ins.routes)) {
    ins.routes = masterRoutes(id as InsertId);
    log.count('routes-reset', (n) => `Reset the routing of ${count(n, INSERT)} to the Master track.`);
    return;
  }
  const targets = new Set<string>();
  ins.routes = (ins.routes as unknown[]).filter((r) => {
    const ok =
      id !== MASTER && isObject(r) && isString(r.to) && r.to !== id && has(inserts, r.to) && !targets.has(r.to);
    if (!ok) {
      log.count('routes-bad', (n) => `Removed ${count(n, ROUTE)} to missing or repeated mixer tracks.`);
      return false;
    }
    targets.add(r.to as string);
    let fixed = clampField(r, 'level', 0, INSERT_VOLUME_MAX, 1);
    fixed = requireField(r, 'pre', isBoolean, false) || fixed;
    if (fixed) log.count('routes-fields', (n) => `Fixed ${count(n, ROUTE)} with invalid settings.`);
    return true;
  });
}

/**
 * Audio may not loop: routes (insert → target) and sidechains (source → the slot's insert) form a
 * graph without cycles. Keeps routes before sidechains, each in mixer order, dropping the edges that
 * would close a loop.
 */
function breakRoutingCycles(order: readonly string[], inserts: Obj, log: RepairLog): void {
  const out = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const next of out.get(at) ?? []) stack.push(next);
    }
    return false;
  };
  const accept = (from: string, to: string): boolean => {
    if (from === to || reaches(to, from)) return false;
    let set = out.get(from);
    if (!set) out.set(from, (set = new Set()));
    set.add(to);
    return true;
  };
  for (const id of order) {
    const ins = inserts[id] as Obj;
    ins.routes = (ins.routes as Obj[]).filter((r) => {
      if (accept(id, r.to as string)) return true;
      log.count('routes-loop', (n) => `Removed ${count(n, ROUTE)} that would loop back.`);
      return false;
    });
  }
  for (const id of order) {
    for (const slot of (inserts[id] as Obj).fx as Obj[]) {
      if (slot.sidechain === null || accept(slot.sidechain as string, id)) continue;
      slot.sidechain = null;
      log.count('sidechain-loop', (n) => `Cleared ${count(n, noun('sidechain input'))} that would loop back.`);
    }
  }
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
    if (kind === 'instrument') {
      fixed = clampField(ch, 'rootKey', 0, 127, DEFAULT_ROOT_KEY, true) || fixed;
      if (has(ch, 'pitch') && ch.pitch !== undefined) fixed = clampField(ch, 'pitch', -2400, 2400, 0) || fixed;
    }
    if (kind === 'audioClip') {
      if (has(ch, 'pitch') && ch.pitch !== undefined) fixed = clampField(ch, 'pitch', -2400, 2400, 0) || fixed;
      fixed = optionalField(ch, 'reverse', isBoolean) || fixed;
      fixed = optionalField(ch, 'stretch', (v) => AUDIO_STRETCH.includes(v as AudioStretch)) || fixed;
      if (has(ch, 'sourceBpm') && ch.sourceBpm !== undefined) fixed = clampField(ch, 'sourceBpm', 20, 999, 120) || fixed;
    }
    if (kind === 'automation') {
      fixed = requireField(ch, 'target', (v) => v === null || isParamTarget(v), null) || fixed;
      fixed = repairPoints(ch) || fixed;
      fixed = optionalField(ch, 'range', isRange) || fixed;
      if (isObject(ch.target) && ch.target.kind === 'tempo' && isRange(ch.range)) {
        const r = ch.range as Obj;
        const lo = Math.min(BPM_MAX, Math.max(BPM_MIN, r.min as number));
        const hi = Math.min(BPM_MAX, Math.max(BPM_MIN, r.max as number));
        if (lo < hi && (lo !== r.min || hi !== r.max)) {
          ch.range = { min: lo, max: hi };
          fixed = true;
        } else if (lo >= hi) {
          delete ch.range;
          fixed = true;
        }
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
  // Frozen audio points at the channel it was rendered from: unlink it when that one is gone.
  for (const raw of Object.values(channels)) {
    const ch = raw as Obj;
    if (ch.kind !== 'audioClip' || !has(ch, 'frozenFrom') || ch.frozenFrom === undefined) continue;
    const from = isString(ch.frozenFrom) ? (channels[ch.frozenFrom] as Obj | undefined) : undefined;
    if (from && from !== ch && (from.kind === 'instrument' || from.kind === 'audioClip')) continue;
    delete ch.frozenFrom;
    log.count('frozen', (n) => `Unlinked ${count(n, noun('frozen channel'))} from a channel that no longer exists.`);
  }
  // Sound filters keep what they replaced: a damaged record is forgotten (the filtered audio stays).
  for (const raw of Object.values(channels)) {
    const ch = raw as Obj;
    if (ch.kind !== 'audioClip' || !has(ch, 'filter') || ch.filter === undefined) continue;
    if (isSoundFilter(ch.filter)) continue;
    delete ch.filter;
    log.count('filter', (n) => `Forgot what ${count(n, noun('sound filter'))} replaced (the filtered audio stays).`);
  }
  log.flush();
}

const isClipCopy = (v: unknown) =>
  isObject(v) &&
  isId(v.id) &&
  isId(v.laneId) &&
  isFiniteNumber(v.start) &&
  isFiniteNumber(v.length) &&
  v.length >= 1 &&
  ((v.kind === 'pattern' && isId(v.patternId) && isFiniteNumber(v.offset)) ||
    (v.kind === 'audio' && isId(v.channelId) && isFiniteNumber(v.offsetSec)) ||
    (v.kind === 'automation' && isId(v.channelId) && isFiniteNumber(v.offset)));

/** A structurally valid `AudioClipChannel.filter` (what it refers to may be gone: removing it skips that). */
function isSoundFilter(v: unknown): boolean {
  if (!isObject(v) || !isString(v.preset) || !isFiniteNumber(v.from) || !isFiniteNumber(v.to)) return false;
  if (!Array.isArray(v.originals) || !v.originals.every(isClipCopy)) return false;
  if (!Array.isArray(v.pieces) || !v.pieces.every(isId)) return false;
  if (v.insert !== undefined) {
    const i = v.insert;
    if (!isObject(i) || !isId(i.id) || !isBoolean(i.made) || !isString(i.name)) return false;
    if (!Array.isArray(i.slots) || !i.slots.every(isId)) return false;
  }
  if (v.tempo !== undefined) {
    const t = v.tempo;
    if (!isObject(t) || !(isFiniteNumber(t.bpm) || isId(t.channelId))) return false;
  }
  return true;
}

function repairNote(note: Obj, log: RepairLog): void {
  let fixed = clampField(note, 'tick', 0, Number.MAX_SAFE_INTEGER, 0, true);
  fixed = clampField(note, 'length', 1, Number.MAX_SAFE_INTEGER, DEFAULT_NOTE_LENGTH, true) || fixed;
  fixed = clampField(note, 'key', 0, 127, DEFAULT_ROOT_KEY, true) || fixed;
  if (has(note, 'pan') && note.pan !== undefined) fixed = clampField(note, 'pan', -1, 1, 0) || fixed;
  if (has(note, 'release') && note.release !== undefined) fixed = clampField(note, 'release', 0, 1, 0.5) || fixed;
  if (has(note, 'fine') && note.fine !== undefined) fixed = clampField(note, 'fine', -100, 100, 0) || fixed;
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
  repairDerivations(patterns, log);
  p.patternOrder = repairOrder(p.patternOrder as unknown[], patterns, known, 'pattern list', PATTERN, log);
  if ((p.patternOrder as string[]).length === 0) {
    const pattern = makePattern('Pattern 1', paletteColor(0));
    patterns[pattern.id] = pattern;
    p.patternOrder = [pattern.id];
    log.add('Added an empty pattern because the project had none.');
  }
}

const isVariantStep = (v: unknown): boolean =>
  isObject(v) &&
  VARIANT_KINDS.includes(v.kind as VariantKind) &&
  isFiniteNumber(v.from) &&
  isFiniteNumber(v.to) &&
  (v.from as number) >= 0 &&
  (v.to as number) > (v.from as number) &&
  (v.parts === undefined || (Array.isArray(v.parts) && v.parts.every(isString)));

/**
 * Variants (`Pattern.derived`) must point at another pattern that exists, without a loop, and hold
 * well-formed steps; otherwise they become ordinary patterns (their notes stay).
 */
function repairDerivations(patterns: Obj, log: RepairLog): void {
  for (const raw of Object.values(patterns)) {
    const pat = raw as Obj;
    if (!has(pat, 'derived') || pat.derived === undefined) continue;
    const d = pat.derived;
    const ok =
      isObject(d) &&
      isString(d.from) &&
      d.from !== pat.id &&
      has(patterns, d.from) &&
      Array.isArray(d.steps) &&
      d.steps.every(isVariantStep) &&
      isFiniteNumber(d.seed) &&
      isString(d.hash);
    if (ok) continue;
    delete pat.derived;
    log.count('derived', (n) => `Made ${count(n, noun('variant pattern'))} ordinary patterns (what they varied is gone or damaged).`);
  }
  // A loop of variants (A varies B varies A) has no source: the pattern that closes it lets go.
  for (const raw of Object.values(patterns)) {
    const pat = raw as Obj;
    const seen = new Set<string>([pat.id as string]);
    let next = isObject(pat.derived) ? (pat.derived.from as string) : undefined;
    while (next && !seen.has(next)) {
      seen.add(next);
      const up = patterns[next] as Obj | undefined;
      next = up && isObject(up.derived) ? (up.derived.from as string) : undefined;
    }
    if (next && next === pat.id) {
      delete pat.derived;
      log.count('derived', (n) => `Made ${count(n, noun('variant pattern'))} ordinary patterns (what they varied is gone or damaged).`);
    }
  }
  log.flush();
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
    if (kind === 'audio') {
      fixed = clampField(clip, 'offsetSec', 0, Number.MAX_VALUE, 0) || fixed;
      if (has(clip, 'gain') && clip.gain !== undefined) fixed = clampField(clip, 'gain', 0, 4, 1) || fixed;
      for (const fade of ['fadeIn', 'fadeOut'])
        if (has(clip, fade) && clip[fade] !== undefined) fixed = clampField(clip, fade, 0, 3600, 0) || fixed;
      // ---- pitch correction: the edit is cleaned; a render that is not in the samples is forgotten ----
      if (has(clip, 'pitchEdit') && clip.pitchEdit !== undefined) {
        const before = isObject(clip.pitchEdit) && Array.isArray(clip.pitchEdit.notes) ? clip.pitchEdit.notes.length : -1;
        const edit = sanitizePitchEdit(clip.pitchEdit);
        if (!edit) {
          delete clip.pitchEdit;
          fixed = true;
        } else {
          if (edit.renderedSampleId && !has(p.samples as Obj, edit.renderedSampleId)) {
            delete edit.renderedSampleId;
            delete edit.renderedFor;
            fixed = true;
          }
          if (edit.notes.length !== before) fixed = true;
          clip.pitchEdit = edit;
        }
      }
      // ---- end of pitch correction ----
    } else fixed = clampField(clip, 'offset', 0, Number.MAX_SAFE_INTEGER, 0, true) || fixed;
    fixed = optionalField(clip, 'muted', isBoolean) || fixed;
    fixed = optionalField(clip, 'name', isString) || fixed;
    fixed = optionalField(clip, 'color', isString) || fixed;
    if (fixed) log.count('clip-fields', (n) => `Fixed ${count(n, CLIP)} with an invalid position or length.`);
  }
  log.flush();
  repairTakes(playlist, log);

  const markers = playlist.markers as Obj;
  repairRecords(markers, MARKER, log);
  for (const raw of Object.values(markers)) {
    const m = raw as Obj;
    let fixed = clampField(m, 'tick', 0, Number.MAX_SAFE_INTEGER, 0, true);
    fixed = requireField(m, 'name', isString, 'Marker') || fixed;
    if ((m.name as string).length > 64) {
      m.name = (m.name as string).slice(0, 64);
      fixed = true;
    }
    fixed = optionalField(m, 'color', isString) || fixed;
    if (fixed) log.count('marker-fields', (n) => `Fixed ${count(n, MARKER)} with an invalid position or name.`);
  }
  log.flush();
}

/**
 * Takes and comping: the tags that tie a recording's takes to its comp lane. Damaged tags go, and so does a
 * group that cannot work (no comp track, or no take left to comp from): its clips and tracks become ordinary
 * ones, so nothing is lost and nothing points at something that is not there.
 */
function repairTakes(playlist: Obj, log: RepairLog): void {
  const lanes = playlist.lanes as Obj;
  const clips = playlist.clips as Obj;
  const damaged = () =>
    log.count('take-tags', (n) => `Removed the take or comp mark from ${count(n, noun('playlist track or clip'))} (it was damaged).`);
  for (const raw of Object.values(lanes)) {
    const lane = raw as Obj;
    if (!has(lane, 'takes') || lane.takes === undefined) continue;
    const t = lane.takes;
    if (!isObject(t) || !isString(t.group) || t.group === '' || (t.role !== 'comp' && t.role !== 'take')) {
      delete lane.takes;
      damaged();
    } else if (has(t, 'crossfadeMs') && t.crossfadeMs !== undefined) {
      if (clampField(t, 'crossfadeMs', 0, 500, 10)) damaged();
    }
  }
  const groups = new Map<string, { comp: number; takes: number }>();
  const entry = (g: string) => {
    let e = groups.get(g);
    if (!e) groups.set(g, (e = { comp: 0, takes: 0 }));
    return e;
  };
  for (const raw of Object.values(lanes)) {
    const t = (raw as Obj).takes as Obj | undefined;
    if (t?.role === 'comp') entry(t.group as string).comp++;
  }
  for (const [id, raw] of Object.entries(clips)) {
    const clip = raw as Obj;
    if (!has(clip, 'take') || clip.take === undefined) continue;
    const t = clip.take;
    const ok =
      clip.kind === 'audio' &&
      isObject(t) &&
      isString(t.group) &&
      t.group !== '' &&
      isFiniteNumber(t.index) &&
      t.index >= 0 &&
      Number.isInteger(t.index) &&
      (!has(t, 'comp') || t.comp === undefined || t.comp === true);
    if (!ok) {
      delete clip.take;
      damaged();
      continue;
    }
    if (t.comp !== true) entry(t.group as string).takes++;
    void id;
  }
  const dead = new Set([...groups].filter(([, e]) => e.comp === 0 || e.takes === 0).map(([g]) => g));
  if (dead.size === 0) return;
  for (const raw of Object.values(lanes)) {
    const lane = raw as Obj;
    if (isObject(lane.takes) && dead.has(lane.takes.group as string)) delete lane.takes;
  }
  for (const raw of Object.values(clips)) {
    const clip = raw as Obj;
    if (isObject(clip.take) && dead.has(clip.take.group as string)) delete clip.take;
  }
  log.add(`Made ${dead.size === 1 ? 'a set of takes' : `${dead.size} sets of takes`} ordinary tracks and clips (the comp or the takes were gone).`);
}

const isId = (v: unknown) => isString(v) && v !== '';

/** A structurally valid automation/controller target (it may refer to things that were deleted). */
export function isParamTarget(v: unknown): boolean {
  if (!isObject(v)) return false;
  switch (v.kind) {
    case 'channel':
      return isId(v.channelId) && (v.param === 'volume' || v.param === 'pan' || v.param === 'pitch');
    case 'insert':
      return isId(v.insertId) && (v.param === 'volume' || v.param === 'pan');
    case 'slot':
      return isId(v.insertId) && isId(v.slotId) && v.param === 'mix';
    case 'route':
      return isId(v.insertId) && isId(v.to);
    case 'plugin': {
      const o = v.owner;
      const owner =
        isObject(o) &&
        ((o.kind === 'channel' && isId(o.channelId)) || (o.kind === 'fx' && isId(o.insertId) && isId(o.slotId)));
      return owner && isId(v.paramId);
    }
    case 'tempo':
      return true;
    default:
      return false;
  }
}

const isRange = (v: unknown) =>
  isObject(v) && isFiniteNumber(v.min) && isFiniteNumber(v.max) && (v.min as number) < (v.max as number);

/** Points: objects with a tick and a normalized value, sorted, with valid shapes and tensions. */
function repairPoints(ch: Obj): boolean {
  if (!Array.isArray(ch.points)) {
    ch.points = [];
    return true;
  }
  const raw = ch.points as unknown[];
  const points = raw.filter(isObject);
  let fixed = points.length !== raw.length;
  for (const pt of points) {
    fixed = clampField(pt, 'tick', 0, Number.MAX_SAFE_INTEGER, 0, true) || fixed;
    fixed = clampField(pt, 'value', 0, 1, 0) || fixed;
    if (has(pt, 'tension') && pt.tension !== undefined) fixed = clampField(pt, 'tension', -1, 1, 0) || fixed;
    fixed = optionalField(pt, 'shape', (v) => AUTO_SHAPES.includes(v as never)) || fixed;
  }
  for (let i = 1; i < points.length; i++) {
    if ((points[i]!.tick as number) < (points[i - 1]!.tick as number)) {
      points.sort((a, b) => (a.tick as number) - (b.tick as number));
      fixed = true;
      break;
    }
  }
  ch.points = points;
  return fixed;
}

function repairControllers(p: Obj, log: RepairLog): void {
  if (!isObject(p.controllers)) {
    p.controllers = {};
    log.add('Reset the damaged MIDI controller links.');
    return;
  }
  const links = p.controllers;
  repairRecords(links, LINK, log);
  for (const [id, raw] of Object.entries(links)) {
    const link = raw as Obj;
    const valid =
      Number.isInteger(link.cc) &&
      (link.cc as number) >= 0 &&
      (link.cc as number) <= 127 &&
      (link.channel === null ||
        (Number.isInteger(link.channel) && (link.channel as number) >= 0 && (link.channel as number) <= 15)) &&
      isParamTarget(link.target);
    if (!valid) {
      delete links[id];
      log.count('link-bad', (n) => `Removed ${count(n, LINK)} with invalid settings.`);
      continue;
    }
    let fixed = clampField(link, 'min', 0, 1, 0);
    fixed = clampField(link, 'max', 0, 1, 1) || fixed;
    fixed = optionalField(link, 'device', isString) || fixed;
    if (fixed) log.count('link-fields', (n) => `Fixed ${count(n, LINK)} with an invalid range.`);
  }
  log.flush();
}

const DJ_OPTIONS = {
  order: ['keep', 'auto'],
  energy: ['build', 'party', 'chill', 'peak-time'],
  transition: ['auto', 'smooth', 'quick', 'cut'],
} as const;
const DJ_DEFAULTS: Record<keyof typeof DJ_OPTIONS, string> = { order: 'auto', energy: 'party', transition: 'auto' };

/**
 * The DJ mix (`Project.dj`, optional): its songs must be samples of the project; what it made is
 * filtered to what still exists; broken options go back to the defaults. A mix without songs goes.
 */
function repairDj(p: Obj, log: RepairLog): void {
  if (!has(p, 'dj') || p.dj === undefined) return;
  const dj = p.dj;
  const samples = isObject(p.samples) ? p.samples : {};
  if (!isObject(dj) || !Array.isArray(dj.songs)) {
    delete p.dj;
    log.add('Forgot the damaged DJ mix details (the songs stay on the playlist).');
    return;
  }
  const songs = dj.songs.filter(
    (x): x is Obj =>
      isObject(x) &&
      isString(x.sampleId) &&
      has(samples, x.sampleId) &&
      isString(x.title) &&
      isFiniteNumber(x.start) &&
      isFiniteNumber(x.end),
  );
  if (songs.length === 0) {
    delete p.dj;
    log.add('Forgot the DJ mix details: its songs are gone.');
    return;
  }
  let fixed = songs.length !== dj.songs.length;
  for (const song of songs) {
    if (!(song.bpm === null || isFiniteNumber(song.bpm))) {
      song.bpm = null;
      fixed = true;
    }
    if (!(song.camelot === null || isString(song.camelot))) {
      song.camelot = null;
      fixed = true;
    }
    if (song.deck !== 'A' && song.deck !== 'B') {
      song.deck = 'A';
      fixed = true;
    }
    fixed = optionalField(song, 'pinned', isBoolean) || fixed;
  }
  dj.songs = songs;
  const o = isObject(dj.options) ? dj.options : (dj.options = {});
  for (const [key, allowed] of Object.entries(DJ_OPTIONS)) {
    if (!(allowed as readonly unknown[]).includes(o[key])) {
      o[key] = DJ_DEFAULTS[key as keyof typeof DJ_OPTIONS];
      fixed = true;
    }
  }
  if (!(o.mixTempo === 'follow' || (isFiniteNumber(o.mixTempo) && o.mixTempo >= 50 && o.mixTempo <= 250))) {
    o.mixTempo = 'follow';
    fixed = true;
  }
  fixed = optionalField(o, 'lengthTargetMin', (v) => isFiniteNumber(v) && v > 0) || fixed;
  fixed = optionalField(o, 'keyLock', isBoolean) || fixed;
  if (!isObject(dj.tweaks)) {
    dj.tweaks = {};
    fixed = true;
  }
  const made = isObject(dj.made) ? dj.made : (dj.made = {});
  const channels = isObject(p.channels) ? p.channels : {};
  const markers = isObject(p.playlist) && isObject(p.playlist.markers) ? p.playlist.markers : {};
  const keep = (list: unknown, rec: Obj) =>
    Array.isArray(list) ? list.filter((id): id is string => isString(id) && has(rec, id)) : [];
  made.channels = keep(made.channels, channels);
  made.markers = keep(made.markers, markers);
  if (fixed) log.add('Fixed damaged DJ mix details.');
}

const REFERENCE_KINDS = ['intro', 'build', 'drop', 'break', 'verse', 'outro', 'body'];
/** The reference's tonal bands (`core/reference/bands.ts`): this many values, in dB under the total. */
const REFERENCE_BANDS = 8;
const REFERENCE_FLOOR = -60;
const MAX_REFERENCE_ENERGY = 1024;
const MAX_REFERENCE_SECTIONS = 200;
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A list of exactly the band count of finite dB values (−60…0), or null when it can't be one. */
function fixedBands(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== REFERENCE_BANDS || !v.every(isFiniteNumber)) return null;
  return v.map((x) => clampNum(x as number, REFERENCE_FLOOR, 0));
}

/**
 * The reference track (`Project.reference`, optional): only derived measurements. Anything that can't be
 * read as a measurement removes it (the song and its sample stay); values are clamped to what they can
 * mean; the sample link is dropped when the sample is gone, but the numbers stay.
 */
function repairReference(p: Obj, log: RepairLog): void {
  if (!has(p, 'reference') || p.reference === undefined) return;
  const ref = p.reference;
  if (
    !isObject(ref) ||
    !isString(ref.hash) ||
    !isFiniteNumber(ref.durationSec) ||
    !Array.isArray(ref.sections) ||
    !Array.isArray(ref.energy) ||
    !fixedBands(ref.bands)
  ) {
    delete p.reference;
    log.add('Forgot the damaged reference song details (the song itself is not changed).');
    return;
  }
  let fixed = false;
  const fix = (changed: boolean) => {
    if (changed) fixed = true;
  };
  fix(requireField(ref, 'title', isString, 'Reference'));
  fix(requireField(ref, 'version', isFiniteNumber, 0));
  const bands = fixedBands(ref.bands)!;
  if ((ref.bands as number[]).some((x, i) => x !== bands[i])) fixed = true;
  ref.bands = bands;
  fix(requireField(ref, 'bpm', (v) => v === null || (isFiniteNumber(v) && v >= BPM_MIN && v <= BPM_MAX), null));
  fix(requireField(ref, 'beatsPerBar', (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16, 4));
  fix(requireField(ref, 'lufs', isFiniteNumber, -70));
  fix(requireField(ref, 'truePeakDb', isFiniteNumber, -70));
  fix(requireField(ref, 'width', (v) => isFiniteNumber(v) && v >= 0, 0));
  const key = ref.key;
  const keyOk =
    isObject(key) &&
    Number.isInteger(key.root) &&
    (key.root as number) >= 0 &&
    (key.root as number) <= 11 &&
    (key.mode === 'major' || key.mode === 'minor') &&
    isString(key.camelot) &&
    isFiniteNumber(key.confidence);
  if (key !== null && !keyOk) {
    ref.key = null;
    fixed = true;
  }
  const energy = (ref.energy as unknown[]).filter(isFiniteNumber).slice(0, MAX_REFERENCE_ENERGY);
  const clampedEnergy = energy.map((e) => clampNum(e, 0, 1));
  if (clampedEnergy.length !== ref.energy.length || clampedEnergy.some((e, i) => e !== energy[i])) fixed = true;
  ref.energy = clampedEnergy;
  const sections = (ref.sections as unknown[]).filter(
    (x): x is Obj =>
      isObject(x) &&
      REFERENCE_KINDS.includes(x.kind as string) &&
      isFiniteNumber(x.startSec) &&
      isFiniteNumber(x.endSec) &&
      x.endSec > x.startSec &&
      x.startSec >= 0,
  );
  if (sections.length !== ref.sections.length) fixed = true;
  for (const s of sections) {
    const span = (s.endSec as number) - (s.startSec as number);
    fix(requireField(s, 'bars', (v) => Number.isInteger(v) && (v as number) >= 1, Math.max(1, Math.round(span / 2))));
    fix(requireField(s, 'energy', (v) => isFiniteNumber(v) && v >= 0 && v <= 1, 0.5));
    fix(requireField(s, 'width', (v) => isFiniteNumber(v) && v >= 0, 0));
    const sb = fixedBands(s.bands);
    if (!sb || (s.bands as number[]).some((x, i) => x !== sb[i])) fixed = true;
    s.bands = sb ?? new Array<number>(REFERENCE_BANDS).fill(REFERENCE_FLOOR);
  }
  if (sections.length > MAX_REFERENCE_SECTIONS) fixed = true;
  ref.sections = sections.slice(0, MAX_REFERENCE_SECTIONS);
  if (has(ref, 'sampleId') && ref.sampleId !== undefined) {
    const samples = isObject(p.samples) ? p.samples : {};
    if (!isString(ref.sampleId) || !has(samples, ref.sampleId)) {
      delete ref.sampleId;
      fixed = true;
    }
  }
  if (fixed) log.add('Fixed damaged reference song details.');
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
  repairControllers(p, log);
  repairDj(p, log);
  repairReference(p, log);
  log.flush();
  return { project: p as unknown as Project, repairs: log.messages };
}
