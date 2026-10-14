import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PluginInstance, PluginOwner } from '@core/model/types';
import { setPluginParams, setPluginState } from '@core/ops/channels';
import { defaultValues, resolveValues, type JsonValue, type ParamSpecs, type ParamValue, type PluginDef } from '@agstudio/sdk';
import type { Services } from '@app/services';
import {
  applyPreset,
  exportPresetFile,
  importPresetFile,
  isAtPreset,
  presetChoices,
  randomValues,
  varyValues,
  type PresetChoice,
} from '@app/presets';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { showDialog } from '../../controls/Dialog';
import { showFormDialog } from '../../controls/FormDialog';
import { useServices } from '../../services-context';
import styles from './PresetBar.module.css';

const currentValues = (def: PluginDef, instance: PluginInstance) =>
  resolveValues(def.params as ParamSpecs, instance.params) as Record<string, ParamValue>;

/** Asks for a name and saves the plugin's settings as one of your presets. */
export async function savePresetAs(
  s: Services,
  owner: PluginOwner,
  def: PluginDef,
  instance: PluginInstance,
  suggestion: string,
): Promise<void> {
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
  const saved = s.presets.save({
    pluginId: def.id,
    version: def.version,
    name,
    params: currentValues(def, instance),
    ...(instance.state !== undefined ? { state: instance.state as JsonValue } : {}),
  });
  s.presets.noteLoaded(owner, saved.name);
  s.session.getState().toast(`Saved “${saved.name}”. It’s in this plugin’s preset list and under Presets in the browser.`);
}

/**
 * The preset bar in a plugin window's header: ◀ name ▶ steps through the factory presets and yours;
 * the name opens the preset menu (save, rename, delete, reset, randomize, export and import).
 */
export function PresetBar({ owner, def, instance }: { owner: PluginOwner; def: PluginDef; instance: PluginInstance }) {
  const s = useServices();
  const subscribe = useCallback((fn: () => void) => s.presets.subscribe(fn), [s]);
  useSyncExternalStore(subscribe, () => s.presets.getVersion());

  const choices = presetChoices(def, s.presets);
  const exact = choices.find((c) => isAtPreset(def, instance, c));
  const lastName = s.presets.loadedInto(owner);
  const last = exact ?? choices.find((c) => c.name === lastName);
  const atDefault = isAtPreset(def, instance, {
    name: 'Default',
    source: 'factory',
    params: defaultValues(def.params as ParamSpecs),
    state: def.defaultState,
  });
  const label = exact ? exact.name : lastName ? `${lastName} (edited)` : atDefault ? 'Default settings' : 'Your settings';
  // Settings that match a preset count as that preset, so turning a knob shows "(edited)".
  const exactName = exact?.name;
  useEffect(() => {
    if (exactName && s.presets.loadedInto(owner) !== exactName) s.presets.noteLoaded(owner, exactName);
  }, [exactName, owner, s]);
  const userPreset = last?.source === 'user' && last.id ? s.presets.get(last.id) : undefined;

  const load = (c: PresetChoice) => applyPreset(s, owner, def, c);
  const step = (delta: number) => {
    if (choices.length === 0) return;
    const i = last ? choices.indexOf(last) : -1;
    const next = i < 0 ? (delta > 0 ? 0 : choices.length - 1) : (i + delta + choices.length) % choices.length;
    const c = choices[next];
    if (c) load(c);
  };
  const setAll = (params: Record<string, ParamValue>, what: string, state?: unknown) => {
    s.history.transact(`${def.name}: ${what}`, (d) => {
      setPluginParams(d, owner, params);
      if (state !== undefined) setPluginState(d, owner, state as JsonValue);
    });
    s.presets.noteLoaded(owner, null);
  };

  const remove = async () => {
    if (!userPreset) return;
    const answer = await showDialog({
      title: 'Delete the preset?',
      message: `“${userPreset.name}” will be gone from your ${def.name} presets.`,
      detail: 'Projects that use these settings keep them. To keep a copy, export it as a file first.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'delete', label: 'Delete', danger: true, primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'delete') return;
    s.presets.remove(userPreset.id);
    if (lastName === userPreset.name) s.presets.noteLoaded(owner, null);
  };
  const rename = async () => {
    if (!userPreset) return;
    const got = await showFormDialog({
      title: 'Rename preset',
      fields: [{ kind: 'text', key: 'name', label: 'Name' }],
      values: { name: userPreset.name },
      okLabel: 'Rename',
    });
    const name = got ? String(got.name).trim() : '';
    if (!name || name === userPreset.name) return;
    if (!s.presets.rename(userPreset.id, name))
      s.session.getState().toast(`You already have a ${def.name} preset called “${name}”.`, 'error');
    else if (lastName === userPreset.name) s.presets.noteLoaded(owner, name);
  };
  const saveChanges = () => {
    if (!userPreset) return;
    s.presets.save({
      pluginId: def.id,
      version: def.version,
      name: userPreset.name,
      params: currentValues(def, instance),
      ...(instance.state !== undefined ? { state: instance.state as JsonValue } : {}),
    });
    s.presets.noteLoaded(owner, userPreset.name);
    s.session.getState().toast(`Saved your changes to “${userPreset.name}”`);
  };

  const menu = (at: { clientX: number; clientY: number }) => {
    const item = (c: PresetChoice): MenuEntry => ({
      label: c.name,
      checked: c === exact,
      onSelect: () => load(c),
      hint: c.source === 'user' ? 'One of your presets' : `A ${def.name} factory preset`,
    });
    const factory = choices.filter((c) => c.source === 'factory');
    const mine = choices.filter((c) => c.source === 'user');
    const entries: MenuEntry[] = [];
    if (factory.length) entries.push({ kind: 'label', label: 'Factory presets' }, ...factory.map(item));
    entries.push({ kind: 'label', label: 'Your presets' });
    if (mine.length) entries.push(...mine.map(item));
    else
      entries.push({
        label: 'None yet. “Save as preset…” keeps this sound.',
        disabled: true,
        onSelect: () => {},
      });
    entries.push(
      { kind: 'separator' },
      {
        label: 'Save as preset…',
        onSelect: () => void savePresetAs(s, owner, def, instance, last && !exact ? `${last.name} 2` : ''),
        hint: 'Keep how this plugin is set now as a preset of your own',
      },
    );
    if (userPreset && !exact)
      entries.push({
        label: `Save changes to “${userPreset.name}”`,
        onSelect: saveChanges,
        hint: 'Overwrite your preset with the current settings',
      });
    if (userPreset)
      entries.push(
        { label: `Rename “${userPreset.name}”…`, onSelect: () => void rename() },
        { label: `Delete “${userPreset.name}”…`, danger: true, onSelect: () => void remove() },
      );
    entries.push(
      { kind: 'separator' },
      {
        label: 'Reset to default',
        disabled: atDefault,
        onSelect: () => setAll(defaultValues(def.params as ParamSpecs), 'Reset', def.defaultState),
        hint: 'Every knob back to where it starts',
      },
      {
        kind: 'submenu',
        label: 'Randomize',
        hint: 'Happy accidents: new random settings (output levels stay put; undo with ⌘Z)',
        items: () => [
          {
            label: 'Vary a little',
            onSelect: () => setAll(varyValues(def, currentValues(def, instance), 0.08), 'Vary'),
            hint: 'Nudge every knob slightly from where it is',
          },
          {
            label: 'Vary a lot',
            onSelect: () => setAll(varyValues(def, currentValues(def, instance), 0.3), 'Vary'),
            hint: 'Move every knob a good way from where it is',
          },
          {
            label: 'Randomize everything',
            onSelect: () => setAll(randomValues(def, currentValues(def, instance)), 'Randomize'),
            hint: 'Completely new random settings',
          },
        ],
      },
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
            if (p && p.pluginId === def.id) load({ name: p.name, source: 'user', id: p.id, params: p.params, state: p.state, version: p.version });
          }),
        hint: 'Add a .agpreset file to your presets',
      },
    );
    showContextMenu(at, entries);
  };

  const hasChoices = choices.length > 0;
  return (
    <div className={styles.bar}>
      <button
        type="button"
        tabIndex={-1}
        className={styles.arrow}
        disabled={!hasChoices}
        onClick={() => step(-1)}
        data-hint={hasChoices ? 'Previous preset' : 'No presets yet'}
        aria-label="Previous preset"
      >
        ◀
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={styles.name}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          menu({ clientX: r.left, clientY: r.bottom + 2 });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          menu(e);
        }}
        data-hint="Presets: load one, save your own, reset or randomize"
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.caret}>▾</span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={styles.arrow}
        disabled={!hasChoices}
        onClick={() => step(1)}
        data-hint={hasChoices ? 'Next preset' : 'No presets yet'}
        aria-label="Next preset"
      >
        ▶
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={styles.save}
        onClick={() => void savePresetAs(s, owner, def, instance, last && !exact ? `${last.name} 2` : '')}
        data-hint="Save these settings as a preset of your own"
      >
        Save…
      </button>
    </div>
  );
}
