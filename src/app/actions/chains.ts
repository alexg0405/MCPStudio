import type { Draft } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { MASTER, type InsertId, type PluginInstance, type Project, type SlotId } from '@core/model/types';
import { addFxSlot, MAX_FX_SLOTS, removeFxSlot, setFxSlotEnabled, setFxSlotMix } from '@core/ops/mixer';
import { setRoute } from '@core/ops/routing';
import { insertLabel } from '@core/query/mixer';
import { channelRoles } from '@core/arrange/roles';
import { projectKey } from '@core/reference/key';
import { chainFromInsert, chainChoices, type ChainChoice, type ChainPreset, type ChainStep, type UserChain } from '../chains';
import { findMixLayout } from '../mix/layout';
import { TUNE } from '../mix/vocal-chains';
import { instanceFor } from '../mix/setup';
import { presetValues } from '../presets';
import type { Services } from '../services';

/** What applying a chain to an insert does with the effects already there. */
export type ChainMode = 'replace' | 'append';

export interface ChainApplied {
  /** The new effect slots with the preset each took (when it is the preset's own settings). */
  slots: { slotId: SlotId; preset?: string }[];
  /** Sends added to the Reverb or Delay returns ("Reverb −14 dB"). */
  sends: string[];
  /** Steps that couldn't be applied, with the reason. */
  skipped: string[];
  /** Effects removed first (replace). */
  removed: number;
}

const TUNE_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const gainOf = (db: number) => Math.min(MAX_INSERT_VOLUME, Math.pow(10, db / 20));

/** A plugin instance for a step: a saved insert's full settings (upgraded to the plugin's version), else a preset and params. */
export function stepInstance(s: Services, step: ChainStep): PluginInstance | null {
  const def = s.plugins.get(step.pluginId);
  if (!def || def.kind !== 'effect') return null;
  if (step.version !== undefined && !step.preset) {
    const { params, state } = presetValues(def, { params: step.params ?? {}, state: step.state, version: step.version });
    return makePluginInstance(def.id, def.version, params, state !== undefined ? { state: state as never } : {});
  }
  return instanceFor(s, step);
}

/**
 * Puts a chain on an insert in a draft: `replace` takes out the insert's effects first, `append` adds
 * after them. A step with a send goes to the mix's Reverb or Delay return (found by name, as the mix
 * setup does) when there is one other than the insert itself; otherwise it is an insert effect. What
 * does not fit (ten slots) or isn't installed is skipped and reported.
 */
export function applyChainToDraft(d: Draft<Project>, s: Services, insertId: InsertId, chain: ChainPreset, mode: ChainMode): ChainApplied {
  const out: ChainApplied = { slots: [], sends: [], skipped: [], removed: 0 };
  const insert = d.mixer.inserts[insertId];
  if (!insert) {
    out.skipped.push('that mixer track doesn’t exist');
    return out;
  }
  const layout = findMixLayout(d as unknown as Project);
  if (mode === 'replace') {
    for (const slot of [...insert.fx]) {
      removeFxSlot(d, insertId, slot.id);
      out.removed++;
    }
  }
  // A factory chain's Tune follows the song's key (set, or found from the notes); a saved chain keeps its own.
  const project = s.doc.getState().project;
  const songKey = chain.steps.some((x) => x.pluginId === TUNE && x.version === undefined)
    ? projectKey(project, channelRoles(project))
    : null;
  for (const step of chain.steps) {
    const target = step.send ? layout.buses[step.send.to] : undefined;
    if (step.send && target) {
      // On the return itself a send to it would loop (and the return is that effect already).
      if (target === insertId) {
        out.skipped.push(`${step.label}: this track is the ${step.send.to} return`);
      } else if (setRoute(d, insertId, target, { level: gainOf(step.send.db) })) {
        out.sends.push(`${d.mixer.inserts[target]?.name ?? step.send.to} send ${Math.round(step.send.db * 10) / 10} dB`);
      } else out.skipped.push(`${step.label}: a send to ${d.mixer.inserts[target]?.name ?? step.send.to} would loop`);
      continue;
    }
    const inst = stepInstance(s, step);
    if (!inst) {
      out.skipped.push(`${step.label}: ${s.plugins.get(step.pluginId) ? 'not an effect' : 'plugin not installed'}`);
      continue;
    }
    const retuned = !!songKey && step.pluginId === TUNE && step.version === undefined;
    if (retuned) {
      inst.params.key = TUNE_KEYS[songKey.root] ?? 'C';
      inst.params.scale = songKey.mode;
    }
    const slotId = addFxSlot(d, insertId, inst);
    if (!slotId) {
      out.skipped.push(`${step.label}: no free effect slot (an insert holds ${MAX_FX_SLOTS})`);
      continue;
    }
    if (step.mix !== undefined) setFxSlotMix(d, insertId, slotId, step.mix);
    if (step.enabled === false) setFxSlotEnabled(d, insertId, slotId, false);
    // Named in the plugin's preset bar when its settings are the preset's own.
    out.slots.push({ slotId, ...(step.preset && !step.params && !retuned ? { preset: step.preset } : {}) });
  }
  return out;
}

/** One line for a toast or chat: what a chain did. */
export function describeApplied(name: string, project: Project, insertId: InsertId, a: ChainApplied): string {
  const parts = [`${a.slots.length} effect${a.slots.length === 1 ? '' : 's'}`];
  if (a.sends.length) parts.push(a.sends.join(', '));
  const text = `Put “${name}” on ${insertLabel(project, insertId)}: ${parts.join(' and ')}${a.removed ? ` (replaced ${a.removed})` : ''}`;
  return a.skipped.length ? `${text}. Left out: ${a.skipped.join('; ')}` : text;
}

/** Applies a chain to an insert as one undo step. Returns what it did, or null when the insert doesn't exist. */
export function applyChain(s: Services, insertId: InsertId, chain: ChainPreset, mode: ChainMode): ChainApplied | null {
  if (!s.doc.getState().project.mixer.inserts[insertId]) return null;
  let result: ChainApplied | null = null;
  s.history.transact(`Chain: ${chain.name}`, (d) => {
    result = applyChainToDraft(d, s, insertId, chain, mode);
  });
  const applied = result as ChainApplied | null;
  if (!applied) return null;
  for (const { slotId, preset } of applied.slots) if (preset) s.presets.noteLoaded({ kind: 'fx', insertId, slotId }, preset);
  s.session.getState().toast(describeApplied(chain.name, s.doc.getState().project, insertId, applied), applied.skipped.length ? 'error' : 'info');
  return applied;
}

/** The insert the browser and menus act on: the one selected in the mixer, else the master. */
export function chainTarget(s: Services): InsertId {
  const selected = s.session.getState().selectedInsertId;
  return selected && s.doc.getState().project.mixer.inserts[selected] ? selected : MASTER;
}

/** Every chain you can apply: the factory ones, then yours. */
export function allChains(s: Services): ChainChoice[] {
  return chainChoices(s.presets.chains());
}

/** Saves an insert's effects as one of your chains (a chain of the same name is replaced). Null when it has none. */
export function saveInsertChain(s: Services, insertId: InsertId, name: string, description?: string): UserChain | null {
  const chain = chainFromInsert(s.doc.getState().project, insertId, s.plugins, name);
  if (!chain) return null;
  return s.presets.saveChain(description ? { ...chain, description } : chain);
}
