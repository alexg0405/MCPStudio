import type { PluginDef, JsonValue, ParamSpecs, ParamValue } from '@agstudio/sdk';
import { resolveValues } from '@agstudio/sdk';
import { MAX_FX_SLOTS } from '@core/ops/mixer';
import type { InsertId, Project } from '@core/model/types';
import { downloadBytes, uploadFile } from '@platform/fs-access';
import type { FxRecipe } from './mix/recipes';
import type { Services } from './services';
import { FACTORY_CHAINS } from './mix/vocal-chains';

/**
 * Chain presets: a row of effects with their settings under a name, applied to a mixer insert in one
 * step (the vocal chains: EQ, tuning, de-esser, compressor, doubler, reverb). A step is an `FxRecipe`
 * (the same plugin id / preset name / params the mix setup uses) plus what a chain needs on top: the
 * slot's dry/wet, a bypassed start, the plugin's saved state, and a send to the mix's Reverb or Delay
 * return instead of an insert effect when the song has one.
 */
export interface ChainStep extends FxRecipe {
  /** The effect slot's dry/wet, 0–1 (default 1). */
  mix?: number;
  /** false adds the effect bypassed. */
  enabled?: boolean;
  /** The plugin's state, for a step saved from an insert. */
  state?: JsonValue;
  /** The plugin's version when `params` (all of them) were saved: older ones are upgraded by its `migrate`. */
  version?: number;
  /**
   * Where the mix has a return bus with this name (Reverb, Delay) the step is a send to it at `db`
   * (post-fader) and adds no effect; otherwise it is an insert effect with `preset` and `params`.
   */
  send?: { to: 'reverb' | 'delay'; db: number };
}

export interface ChainPreset {
  name: string;
  /** What it is for, in a sentence. */
  description?: string;
  steps: ChainStep[];
}

/** One of your own chains (kept in this browser). */
export interface UserChain extends ChainPreset {
  id: string;
  /** Date.now() when saved. */
  saved: number;
}

/** A chain you can apply: a factory one or one of yours. */
export interface ChainChoice extends ChainPreset {
  source: 'factory' | 'user';
  /** Your chains' id. */
  id?: string;
}

/** Factory chains first, then yours by name. */
export function chainChoices(mine: readonly UserChain[]): ChainChoice[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [
    ...FACTORY_CHAINS.map((c): ChainChoice => ({ ...c, source: 'factory' })),
    ...[...mine].sort((a, b) => collator.compare(a.name, b.name)).map((c): ChainChoice => ({ ...c, source: 'user', id: c.id })),
  ];
}

/** A chain by name: exactly (any case), else the only one whose name contains the text. */
export function findChainChoice(choices: readonly ChainChoice[], text: string): ChainChoice | undefined {
  const q = text.trim().toLowerCase();
  if (!q) return undefined;
  // Yours win over a factory chain of the same name.
  const exact = [...choices].reverse().find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const part = choices.filter((c) => c.name.toLowerCase().includes(q));
  return part.length === 1 ? part[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Checking a chain read from a file or from storage.

const MAX_STEPS = 20;
const SEND_TARGETS = ['reverb', 'delay'] as const;

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isParamValue = (x: unknown): x is ParamValue => typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string';
const isJson = (x: unknown): x is JsonValue => {
  try {
    return JSON.stringify(x) !== undefined;
  } catch {
    return false;
  }
};

/** Checks one step; returns it cleaned up, or what is wrong with it in plain words. */
function readStep(raw: unknown, index: number): ChainStep | string {
  const where = `Effect ${index + 1}`;
  if (!isRecord(raw)) return `${where} isn’t an effect.`;
  if (typeof raw.pluginId !== 'string' || !raw.pluginId) return `${where} has no plugin.`;
  const step: ChainStep = {
    pluginId: raw.pluginId,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 120) : raw.pluginId,
  };
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== 'string') return `${where}: the preset name isn’t text.`;
    step.preset = raw.preset.slice(0, 80);
  }
  if (raw.params !== undefined) {
    if (!isRecord(raw.params)) return `${where}: the settings aren’t readable.`;
    const params: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(raw.params)) {
      if (!isParamValue(v) || (typeof v === 'number' && !Number.isFinite(v))) return `${where}: the setting “${k}” isn’t a number, a switch or a choice.`;
      params[k] = v;
    }
    step.params = params;
  }
  if (raw.state !== undefined) {
    if (!isJson(raw.state)) return `${where}: its saved state isn’t readable.`;
    step.state = raw.state;
  }
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return `${where}: its plugin version isn’t a number.`;
    step.version = raw.version;
  }
  if (raw.mix !== undefined) {
    if (typeof raw.mix !== 'number' || !(raw.mix >= 0 && raw.mix <= 1)) return `${where}: its mix must be between 0 and 1.`;
    step.mix = raw.mix;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return `${where}: “enabled” must be true or false.`;
    step.enabled = raw.enabled;
  }
  if (raw.send !== undefined) {
    const send = raw.send;
    if (!isRecord(send) || !(SEND_TARGETS as readonly unknown[]).includes(send.to) || typeof send.db !== 'number' || !(send.db >= -60 && send.db <= 12))
      return `${where}: its send must go to the reverb or the delay, between −60 and +12 dB.`;
    step.send = { to: send.to as 'reverb' | 'delay', db: send.db };
  }
  return step;
}

/** Checks a chain's name, description and steps; returns the cleaned chain or the reason it can't be used. */
export function readChain(raw: unknown): ChainPreset | { error: string } {
  if (!isRecord(raw)) return { error: 'This isn’t a chain.' };
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  if (!name) return { error: 'The chain has no name.' };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { error: 'The chain has no effects in it.' };
  if (raw.steps.length > MAX_STEPS) return { error: `A chain holds at most ${MAX_STEPS} effects.` };
  const steps: ChainStep[] = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const step = readStep(raw.steps[i], i);
    if (typeof step === 'string') return { error: step };
    steps.push(step);
  }
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 300) : undefined;
  return { name, ...(description ? { description } : {}), steps };
}

// ---------------------------------------------------------------------------------------------
// Chain files (.agchain): JSON, so they can be shared, kept, or edited by hand.

const FORMAT = 'agstudio-chain';

export function chainFileBytes(chain: ChainPreset): Uint8Array {
  const file = { format: FORMAT, formatVersion: 1, name: chain.name, ...(chain.description ? { description: chain.description } : {}), steps: chain.steps };
  return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}

/** Reads a .agchain file; an error says what is wrong with it. Every plugin in it must be installed. */
export function readChainFile(text: string, plugins: { get(id: string): PluginDef | undefined }): ChainPreset | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'This isn’t a chain file (it isn’t readable JSON).' };
  }
  if (!isRecord(raw) || raw.format !== FORMAT) return { error: 'This isn’t an AGstudio chain file.' };
  const chain = readChain(raw);
  if ('error' in chain) return chain;
  for (const step of chain.steps) {
    const def = plugins.get(step.pluginId);
    if (!def) return { error: `This chain uses “${step.label}”, which isn’t installed (${step.pluginId}).` };
    if (def.kind !== 'effect') return { error: `“${step.label}” isn’t an effect, so it can’t go in a chain.` };
  }
  return chain;
}

export function chainFileName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'chain'}.agchain`;
}

/** Downloads a chain as a .agchain file. */
export function exportChainFile(chain: ChainPreset): void {
  downloadBytes(chainFileName(`Chain - ${chain.name}`), chainFileBytes(chain), 'application/json');
}

/** Asks for a .agchain file and adds it to your chains; null when cancelled or unreadable (the toast says why). */
export async function importChainFile(s: Services): Promise<UserChain | null> {
  const file = await uploadFile('.agchain,application/json');
  return file ? importChainText(s, await file.text()) : null;
}

/** Adds the chain in a .agchain file's text to your chains (a file opened with the installed app arrives this way). */
export function importChainText(s: Services, text: string): UserChain | null {
  const read = readChainFile(text, s.plugins);
  if ('error' in read) {
    s.session.getState().toast(read.error, 'error');
    return null;
  }
  const saved = s.presets.saveChain(read);
  s.session.getState().toast(`Added “${saved.name}” to your chains`);
  return saved;
}

// ---------------------------------------------------------------------------------------------
// Saving an insert's effects.

/** The effects of an insert as a chain: every plugin with all its settings, state, dry/wet and bypass. */
export function chainFromInsert(
  project: Project,
  insertId: InsertId,
  plugins: { get(id: string): PluginDef | undefined },
  name: string,
): ChainPreset | null {
  const insert = project.mixer.inserts[insertId];
  if (!insert) return null;
  const steps: ChainStep[] = [];
  for (const slot of insert.fx) {
    const def = plugins.get(slot.plugin.pluginId);
    if (!def) continue; // a plugin that isn't installed can't be saved with its settings understood
    steps.push({
      pluginId: def.id,
      label: def.name,
      version: slot.plugin.pluginVersion,
      params: resolveValues(def.params as ParamSpecs, slot.plugin.params) as Record<string, ParamValue>,
      ...(slot.plugin.state !== undefined ? { state: slot.plugin.state as JsonValue } : {}),
      ...(slot.mix !== 1 ? { mix: slot.mix } : {}),
      ...(slot.enabled ? {} : { enabled: false }),
    });
  }
  return steps.length ? { name: name.trim().slice(0, 80) || 'My chain', steps: steps.slice(0, MAX_FX_SLOTS) } : null;
}
