/** What the preset bar does to your presets and to the plugin's settings: save, replace, rename, delete, reset and randomize. */
import type { PluginInstance, PluginOwner } from '@core/model/types';
import { setPluginParams, setPluginState } from '@core/ops/channels';
import { resolveValues, type JsonValue, type ParamSpecs, type ParamValue, type PluginDef } from '@agstudio/sdk';
import type { Services } from '@app/services';
import type { UserPreset } from '@app/presets';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';

/** The plugin's settings now, as a value for every parameter. */
export const currentValues = (def: PluginDef, instance: PluginInstance) =>
  resolveValues(def.params as ParamSpecs, instance.params) as Record<string, ParamValue>;

/** Saves the plugin's settings under `name` as one of your presets, and says the plugin loaded it last. */
function savePreset(s: Services, owner: PluginOwner, def: PluginDef, instance: PluginInstance, name: string): UserPreset {
  const saved = s.presets.save({
    pluginId: def.id,
    version: def.version,
    name,
    params: currentValues(def, instance),
    ...(instance.state !== undefined ? { state: instance.state as JsonValue } : {}),
  });
  s.presets.noteLoaded(owner, saved.name);
  return saved;
}

/** Asks for a name and saves the plugin's settings as one of your presets. */
export async function savePresetAs(s: Services, owner: PluginOwner, def: PluginDef, instance: PluginInstance, suggestion: string): Promise<void> {
  const got = await showFormDialog({
    title: `Save ${def.name} preset`,
    message: 'Saves how this plugin is set right now, so you can load it again in any project.',
    fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. Warm pad' }],
    values: { name: suggestion },
    okLabel: 'Save',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name) return;
  const existing = s.presets.find(def.id, name);
  if (existing) {
    const answer = await showDialog({
      title: 'Replace the preset?',
      message: `You already have a ${def.name} preset called “${existing.name}”.`,
      detail: 'Replacing it keeps the name and saves the current settings in it.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'replace', label: 'Replace', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'replace') return;
  }
  const saved = savePreset(s, owner, def, instance, name);
  s.session.getState().toast(`Saved “${saved.name}”. It’s in this plugin’s preset list and under Presets in the browser.`);
}

/** Overwrites one of your presets with the plugin's current settings. */
export function saveChangesToPreset(s: Services, owner: PluginOwner, def: PluginDef, instance: PluginInstance, preset: UserPreset): void {
  s.presets.save({
    pluginId: def.id,
    version: def.version,
    name: preset.name,
    params: currentValues(def, instance),
    ...(instance.state !== undefined ? { state: instance.state as JsonValue } : {}),
  });
  s.presets.noteLoaded(owner, preset.name);
  s.session.getState().toast(`Saved your changes to “${preset.name}”`);
}

/** Asks before deleting one of your presets. `loadedName` is the preset the plugin loaded last (forgotten when it is the deleted one). */
export async function deleteUserPreset(s: Services, owner: PluginOwner, def: PluginDef, preset: UserPreset, loadedName: string | undefined): Promise<void> {
  const answer = await showDialog({
    title: 'Delete the preset?',
    message: `“${preset.name}” will be gone from your ${def.name} presets.`,
    detail: 'Projects that use these settings keep them. To keep a copy, export it as a file first.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', danger: true, primary: true },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'delete') return;
  s.presets.remove(preset.id);
  if (loadedName === preset.name) s.presets.noteLoaded(owner, null);
}

/** Asks for a new name for one of your presets. */
export async function renameUserPreset(s: Services, owner: PluginOwner, def: PluginDef, preset: UserPreset, loadedName: string | undefined): Promise<void> {
  const got = await showFormDialog({
    title: 'Rename preset',
    fields: [{ kind: 'text', key: 'name', label: 'Name' }],
    values: { name: preset.name },
    okLabel: 'Rename',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name || name === preset.name) return;
  if (!s.presets.rename(preset.id, name)) {
    s.session.getState().toast(`You already have a ${def.name} preset called “${name}”.`, 'error');
    return;
  }
  if (loadedName === preset.name) s.presets.noteLoaded(owner, name);
}

/** Replaces the plugin's parameters (and its state, when given) in one undo step; the plugin then counts as loaded from no preset. */
export function setAllParams(s: Services, owner: PluginOwner, def: PluginDef, params: Record<string, ParamValue>, what: string, state?: unknown): void {
  s.history.transact(`${def.name}: ${what}`, (d) => {
    setPluginParams(d, owner, params);
    if (state !== undefined) setPluginState(d, owner, state as JsonValue);
  });
  s.presets.noteLoaded(owner, null);
}
