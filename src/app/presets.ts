import { randomId } from '@core/model/ids';
import type { PluginInstance, PluginOwner } from '@core/model/types';
import { setPluginParams, setPluginState } from '@core/ops/channels';
import {
  fromNormalized,
  resolveValues,
  toNormalized,
  type JsonValue,
  type ParamSpec,
  type ParamSpecs,
  type ParamValue,
  type PluginDef,
} from '@agstudio/sdk';
import { downloadBytes, uploadFile } from '@platform/fs-access';
import { idbGet, idbSet, isIdbAvailable } from '@platform/idb';
import type { Services } from './services';

/**
 * Presets: the factory presets a plugin ships with, and your own (a plugin's knobs and settings under
 * a name, kept in this browser; export one as a .agpreset file to share it or keep it safe).
 */
export interface UserPreset {
  id: string;
  pluginId: string;
  /** The plugin's `version` when it was saved (older presets are upgraded by its `migrate` on load). */
  version: number;
  name: string;
  params: Record<string, ParamValue>;
  state?: JsonValue;
  /** Date.now() when saved. */
  saved: number;
}

/** Something a plugin can load: one of its factory presets or one of yours. */
export interface PresetChoice {
  name: string;
  source: 'factory' | 'user';
  /** Your presets' id. */
  id?: string;
  params?: Readonly<Record<string, unknown>>;
  state?: unknown;
  version?: number;
}

export interface PresetStorage {
  read(): Promise<unknown>;
  write(list: readonly UserPreset[]): Promise<void>;
}

const KEY = 'user-presets:v1';

export const idbPresetStorage: PresetStorage = {
  read: () => (isIdbAvailable() ? idbGet(KEY) : Promise.resolve([])),
  write: (list) => {
    if (!isIdbAvailable()) return Promise.reject(new Error('This browser has no storage for presets.'));
    return idbSet(KEY, list);
  },
};

export function memoryPresetStorage(initial: UserPreset[] = []): PresetStorage & { list: UserPreset[] } {
  const store = {
    list: initial,
    read: () => Promise.resolve(store.list),
    write: (list: readonly UserPreset[]) => {
      store.list = structuredClone([...list]);
      return Promise.resolve();
    },
  };
  return store;
}

const isPreset = (x: unknown): x is UserPreset => {
  const p = x as Partial<UserPreset> | null;
  return (
    !!p &&
    typeof p.id === 'string' &&
    typeof p.pluginId === 'string' &&
    typeof p.name === 'string' &&
    typeof p.version === 'number' &&
    !!p.params &&
    typeof p.params === 'object'
  );
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const ownerKey = (o: PluginOwner) => (o.kind === 'fx' ? `fx:${o.insertId}:${o.slotId}` : `channel:${o.channelId}`);

/** Your presets (loaded from browser storage once at startup) and which preset each plugin last loaded. */
export class PresetLibrary {
  private items: UserPreset[] = [];
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private readonly lastLoaded = new Map<string, string>();

  constructor(
    private readonly storage: PresetStorage = idbPresetStorage,
    /** Saving failed (shown to the musician). */
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Reads the saved presets (once; later calls return the same promise). */
  load(): Promise<void> {
    return (this.loading ??= this.storage
      .read()
      .then((raw) => {
        const saved = Array.isArray(raw) ? raw.filter(isPreset) : [];
        const mine = new Set(this.items.map((p) => p.id));
        this.items = [...saved.filter((p) => !mine.has(p.id)), ...this.items];
        this.emit();
      })
      .catch(() => {}));
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all(): readonly UserPreset[] {
    return this.items;
  }

  /** Your presets for one plugin, by name. */
  forPlugin(pluginId: string): UserPreset[] {
    return this.items.filter((p) => p.pluginId === pluginId).sort((a, b) => collator.compare(a.name, b.name));
  }

  get(id: string): UserPreset | undefined {
    return this.items.find((p) => p.id === id);
  }

  find(pluginId: string, name: string): UserPreset | undefined {
    return this.items.find((p) => p.pluginId === pluginId && same(p.name, name));
  }

  /** Saves a preset; one of yours for the same plugin with the same name is replaced. */
  save(input: Omit<UserPreset, 'id' | 'saved'>): UserPreset {
    const name = input.name.trim().slice(0, 80) || 'My preset';
    const old = this.find(input.pluginId, name);
    const preset: UserPreset = {
      ...structuredClone(input),
      name,
      id: old?.id ?? randomId('pre'),
      saved: Date.now(),
    };
    if (preset.state === undefined) delete preset.state;
    this.items = old ? this.items.map((p) => (p.id === old.id ? preset : p)) : [...this.items, preset];
    this.changed();
    return preset;
  }

  /** Renames one of your presets; false when another one of that plugin already has the name. */
  rename(id: string, name: string): boolean {
    const p = this.get(id);
    const next = name.trim().slice(0, 80);
    if (!p || !next) return false;
    const clash = this.find(p.pluginId, next);
    if (clash && clash.id !== id) return false;
    this.items = this.items.map((x) => (x.id === id ? { ...x, name: next } : x));
    this.changed();
    return true;
  }

  remove(id: string): UserPreset | undefined {
    const p = this.get(id);
    if (!p) return undefined;
    this.items = this.items.filter((x) => x.id !== id);
    this.changed();
    return p;
  }

  /** Puts back a preset you deleted (undo). */
  restore(p: UserPreset): void {
    if (this.get(p.id)) return;
    this.items = [...this.items, p];
    this.changed();
  }

  /** The preset a plugin loaded last (the name shows "edited" once you turn a knob). */
  loadedInto(owner: PluginOwner): string | undefined {
    return this.lastLoaded.get(ownerKey(owner));
  }

  noteLoaded(owner: PluginOwner, name: string | null): void {
    if (name === null) this.lastLoaded.delete(ownerKey(owner));
    else this.lastLoaded.set(ownerKey(owner), name);
    this.emit();
  }

  private changed(): void {
    this.emit();
    // After loading: writing first would replace what's stored with only the presets saved so far.
    void this.load()
      .then(() => this.storage.write(this.items))
      .catch((e: unknown) => {
        this.onError(
          `Your presets couldn’t be saved in this browser (${e instanceof Error ? e.message : String(e)}). Export them as files to keep them.`,
        );
      });
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

/** A plugin's presets: its factory presets first, then yours. */
export function presetChoices(def: PluginDef, library: PresetLibrary): PresetChoice[] {
  return [
    ...(def.presets ?? []).map((p): PresetChoice => ({
      name: p.name,
      source: 'factory',
      params: p.params as Record<string, unknown> | undefined,
      state: p.state,
    })),
    ...library.forPlugin(def.id).map(
      (p): PresetChoice => ({
        name: p.name,
        source: 'user',
        id: p.id,
        params: p.params,
        state: p.state,
        version: p.version,
      }),
    ),
  ];
}

/**
 * Every param's value for a preset (factory presets leave out the ones at their default) and its
 * state (undefined = the preset keeps the plugin's current state), upgraded to the plugin's version.
 */
export function presetValues(
  def: PluginDef,
  preset: Pick<PresetChoice, 'params' | 'state' | 'version'>,
): { params: Record<string, ParamValue>; state: JsonValue | undefined } {
  let params: Readonly<Record<string, unknown>> = preset.params ?? {};
  let state = preset.state;
  if (preset.version !== undefined && preset.version < def.version && def.migrate) {
    const up = def.migrate({ version: preset.version, params: { ...params }, state });
    params = up.params;
    state = up.state;
  }
  return {
    params: resolveValues(def.params as ParamSpecs, params) as Record<string, ParamValue>,
    state: state as JsonValue | undefined,
  };
}

/** Loads a preset into a channel's instrument or an effect slot (one undo step). */
export function applyPreset(s: Services, owner: PluginOwner, def: PluginDef, preset: PresetChoice): void {
  const { params, state } = presetValues(def, preset);
  s.history.transact(`${def.name}: ${preset.name}`, (d) => {
    setPluginParams(d, owner, params);
    if (state !== undefined) setPluginState(d, owner, state);
  });
  s.presets.noteLoaded(owner, preset.name);
}

const close = (spec: ParamSpec, a: ParamValue, b: ParamValue) =>
  spec.type === 'float' || spec.type === 'int'
    ? Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(spec.max - spec.min))
    : a === b;

/** Whether a plugin's settings are exactly a preset's. */
export function isAtPreset(def: PluginDef, instance: Pick<PluginInstance, 'params' | 'state'>, preset: PresetChoice): boolean {
  const specs = def.params as ParamSpecs;
  const now = resolveValues(specs, instance.params) as Record<string, ParamValue>;
  const { params, state } = presetValues(def, preset);
  for (const [key, spec] of Object.entries(specs)) if (!close(spec, now[key] ?? spec.default, params[key] ?? spec.default)) return false;
  if (state === undefined) return true;
  return JSON.stringify(state) === JSON.stringify(instance.state ?? def.defaultState ?? null);
}

/** Output levels keep their value when randomizing (so a random sound can't come out deafening). */
const LEVEL = /^(volume|vol|gain|level|output|out|master|outputgain|outgain)$/i;

/** Random settings for happy accidents: every param anywhere in its range, except output levels. */
export function randomValues(
  def: PluginDef,
  current: Readonly<Record<string, ParamValue>>,
  rand: () => number = Math.random,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(def.params as ParamSpecs)) {
    const label = (spec.label ?? '').replace(/\s+/g, '');
    if (LEVEL.test(key) || LEVEL.test(label) || spec.group?.toLowerCase() === 'output') {
      out[key] = current[key] ?? spec.default;
      continue;
    }
    switch (spec.type) {
      case 'enum':
        out[key] = spec.options[Math.floor(rand() * spec.options.length)] ?? spec.default;
        break;
      case 'int':
        out[key] = Math.min(spec.max, spec.min + Math.floor(rand() * (spec.max - spec.min + 1)));
        break;
      default:
        out[key] = fromNormalized(spec, rand());
    }
  }
  return out;
}

/** Nudges every param a little from where it is (amount 0–1 of its range), output levels excepted. */
export function varyValues(
  def: PluginDef,
  current: Readonly<Record<string, ParamValue>>,
  amount: number,
  rand: () => number = Math.random,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(def.params as ParamSpecs)) {
    const v = current[key] ?? spec.default;
    const label = (spec.label ?? '').replace(/\s+/g, '');
    if (spec.type === 'bool' || spec.type === 'enum' || LEVEL.test(key) || LEVEL.test(label) || spec.group?.toLowerCase() === 'output') {
      out[key] = v;
      continue;
    }
    out[key] = fromNormalized(spec, toNormalized(spec, v) + (rand() * 2 - 1) * amount);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Preset files (.agpreset): JSON, so they can be shared, kept, or edited by hand.

const FORMAT = 'agstudio-preset';

export function presetFileBytes(def: PluginDef, name: string, instance: Pick<PluginInstance, 'params' | 'state'>): Uint8Array {
  const file = {
    format: FORMAT,
    formatVersion: 1,
    plugin: def.id,
    pluginName: def.name,
    pluginVersion: def.version,
    name,
    params: resolveValues(def.params as ParamSpecs, instance.params),
    ...(instance.state !== undefined ? { state: instance.state } : {}),
  };
  return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}

/** Reads a .agpreset file; an error message says what's wrong with it in plain words. */
export function readPresetFile(
  text: string,
  plugins: { get(id: string): PluginDef | undefined },
): { value: Omit<UserPreset, 'id' | 'saved'>; def: PluginDef } | { error: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: 'This isn’t a preset file (it isn’t readable JSON).' };
  }
  if (!raw || raw.format !== FORMAT || typeof raw.plugin !== 'string')
    return { error: 'This isn’t an AGstudio preset file.' };
  const def = plugins.get(raw.plugin);
  if (!def)
    return {
      error: `This preset is for ${typeof raw.pluginName === 'string' ? `“${raw.pluginName}”` : `the plugin “${raw.plugin}”`}, which isn’t installed.`,
    };
  const version = typeof raw.pluginVersion === 'number' ? raw.pluginVersion : def.version;
  const params = raw.params && typeof raw.params === 'object' ? (raw.params as Record<string, unknown>) : {};
  const { params: values, state } = presetValues(def, { params, state: raw.state, version });
  return {
    def,
    value: {
      pluginId: def.id,
      version: def.version,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Imported preset',
      params: values,
      ...(state !== undefined ? { state } : {}),
    },
  };
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'preset'}.agpreset`;

/** Downloads the plugin's current settings as a .agpreset file. */
export function exportPresetFile(def: PluginDef, name: string, instance: Pick<PluginInstance, 'params' | 'state'>): void {
  downloadBytes(fileName(`${def.name} - ${name}`), presetFileBytes(def, name, instance), 'application/json');
}

/** Asks for a .agpreset file and adds it to your presets; null when cancelled. */
export async function importPresetFile(s: Services): Promise<UserPreset | null> {
  const file = await uploadFile('.agpreset,application/json');
  if (!file) return null;
  const read = readPresetFile(await file.text(), s.plugins);
  if ('error' in read) {
    s.session.getState().toast(read.error, 'error');
    return null;
  }
  const saved = s.presets.save(read.value);
  s.session.getState().toast(`Added “${saved.name}” to your ${read.def.name} presets`);
  return saved;
}
