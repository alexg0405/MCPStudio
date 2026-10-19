/** The preset menu: factory presets, your presets, save, rename, delete, reset, randomize, export and import. */
import type { PluginInstance, PluginOwner } from '@core/model/types';
import { defaultValues, type ParamSpecs, type ParamValue, type PluginDef } from '@agstudio/sdk';
import type { Services } from '@app/services';
import { applyPreset, exportPresetFile, importPresetFile, randomValues, varyValues, type PresetChoice, type UserPreset } from '@app/presets';
import type { MenuEntry } from '../../controls/ContextMenu';
import { shortcutLabel } from '../../shortcut-label';
import { currentValues, deleteUserPreset, renameUserPreset, saveChangesToPreset, savePresetAs, setAllParams } from './preset-actions';

/** How far "Vary a little" and "Vary a lot" move every knob (a fraction of its range). */
const VARY_A_LITTLE = 0.08;
const VARY_A_LOT = 0.3;

/** What the preset menu needs to know about the plugin and its presets right now. */
export interface PresetMenuContext {
  s: Services;
  owner: PluginOwner;
  def: PluginDef;
  instance: PluginInstance;
  /** The factory presets and yours, in the order the bar steps through them. */
  choices: readonly PresetChoice[];
  /** The preset the settings match exactly, if any. */
  exact: PresetChoice | undefined;
  /** The preset the plugin loaded last (the matching one, else the last one loaded), if any. */
  last: PresetChoice | undefined;
  /** The name of the preset the plugin loaded last, if any. */
  lastName: string | undefined;
  /** Your preset that is `last`, if it is one of yours. */
  userPreset: UserPreset | undefined;
  /** The settings are the plugin's defaults. */
  isAtDefault: boolean;
}

/** One preset as a menu entry; the one the settings match is checked. */
function presetEntry(context: PresetMenuContext, choice: PresetChoice): MenuEntry {
  const { s, owner, def, exact } = context;
  return {
    label: choice.name,
    checked: choice === exact,
    onSelect: () => applyPreset(s, owner, def, choice),
    hint: choice.source === 'user' ? 'One of your presets' : `A ${def.name} factory preset`,
  };
}

/** The lists of presets: factory first (when there are any), then yours (or a note that there are none yet). */
function presetListEntries(context: PresetMenuContext): MenuEntry[] {
  const factory = context.choices.filter((c) => c.source === 'factory');
  const mine = context.choices.filter((c) => c.source === 'user');
  const entries: MenuEntry[] = [];
  if (factory.length) entries.push({ kind: 'label', label: 'Factory presets' }, ...factory.map((c) => presetEntry(context, c)));
  entries.push({ kind: 'label', label: 'Your presets' });
  if (mine.length) {
    entries.push(...mine.map((c) => presetEntry(context, c)));
  } else {
    entries.push({ label: 'None yet. “Save as preset…” keeps this sound.', disabled: true, onSelect: () => {} });
  }
  return entries;
}

/** Save as a new preset, and (for one of yours) save changes, rename and delete. */
function saveEntries(context: PresetMenuContext): MenuEntry[] {
  const { s, owner, def, instance, exact, last, lastName, userPreset } = context;
  const suggestion = last && !exact ? `${last.name} 2` : '';
  const entries: MenuEntry[] = [
    { kind: 'separator' },
    {
      label: 'Save as preset…',
      onSelect: () => void savePresetAs(s, owner, def, instance, suggestion),
      hint: 'Keep how this plugin is set now as a preset of your own',
    },
  ];
  if (userPreset && !exact) {
    entries.push({
      label: `Save changes to “${userPreset.name}”`,
      onSelect: () => saveChangesToPreset(s, owner, def, instance, userPreset),
      hint: 'Overwrite your preset with the current settings',
    });
  }
  if (userPreset) {
    entries.push(
      { label: `Rename “${userPreset.name}”…`, onSelect: () => void renameUserPreset(s, owner, def, userPreset, lastName) },
      { label: `Delete “${userPreset.name}”…`, danger: true, onSelect: () => void deleteUserPreset(s, owner, def, userPreset, lastName) },
    );
  }
  return entries;
}

/** Reset to default and the randomize submenu (vary a little, vary a lot, randomize everything). */
function resetAndRandomizeEntries(context: PresetMenuContext): MenuEntry[] {
  const { s, owner, def, instance, isAtDefault } = context;
  const setAll = (params: Record<string, ParamValue>, what: string, state?: unknown) => setAllParams(s, owner, def, params, what, state);
  const values = () => currentValues(def, instance);
  return [
    { kind: 'separator' },
    {
      label: 'Reset to default',
      disabled: isAtDefault,
      onSelect: () => setAll(defaultValues(def.params as ParamSpecs), 'Reset', def.defaultState),
      hint: 'Every knob back to where it starts',
    },
    {
      kind: 'submenu',
      label: 'Randomize',
      hint: `Happy accidents: new random settings (output levels stay put; undo with ${shortcutLabel(s, 'edit.undo') ?? 'Edit → Undo'})`,
      items: () => [
        { label: 'Vary a little', onSelect: () => setAll(varyValues(def, values(), VARY_A_LITTLE), 'Vary'), hint: 'Nudge every knob slightly from where it is' },
        { label: 'Vary a lot', onSelect: () => setAll(varyValues(def, values(), VARY_A_LOT), 'Vary'), hint: 'Move every knob a good way from where it is' },
        { label: 'Randomize everything', onSelect: () => setAll(randomValues(def, values()), 'Randomize'), hint: 'Completely new random settings' },
      ],
    },
  ];
}

/** Export the settings as a file, and import a preset file for this plugin. */
function fileEntries(context: PresetMenuContext): MenuEntry[] {
  const { s, owner, def, instance, exact, lastName } = context;
  return [
    { kind: 'separator' },
    {
      label: 'Export as file…',
      onSelect: () => exportPresetFile(def, exact?.name ?? lastName ?? 'My preset', instance),
      hint: 'Download these settings as a .agpreset file, to share or keep',
    },
    {
      label: 'Import preset file…',
      onSelect: () =>
        void importPresetFile(s).then((p) => {
          if (p && p.pluginId === def.id) applyPreset(s, owner, def, { name: p.name, source: 'user', id: p.id, params: p.params, state: p.state, version: p.version });
        }),
      hint: 'Add a .agpreset file to your presets',
    },
  ];
}

/** Every entry of the preset menu, top to bottom. */
export function presetMenuEntries(context: PresetMenuContext): MenuEntry[] {
  return [...presetListEntries(context), ...saveEntries(context), ...resetAndRandomizeEntries(context), ...fileEntries(context)];
}
