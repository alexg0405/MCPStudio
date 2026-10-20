import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PluginInstance, PluginOwner } from '@core/model/types';
import { defaultValues, type ParamSpecs, type PluginDef } from '@agstudio/sdk';
import { applyPreset, isAtPreset, presetChoices, type PresetChoice } from '@app/presets';
import { showContextMenu } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import { savePresetAs } from './preset-actions';
import { presetMenuEntries, type PresetMenuContext } from './preset-menu';
import styles from './PresetBar.module.css';

/** The name the bar shows: the matching preset, "(edited)" after the last one loaded, or what the settings are. */
function presetLabel(exact: PresetChoice | undefined, lastName: string | undefined, isAtDefault: boolean): string {
  if (exact) return exact.name;
  if (lastName) return `${lastName} (edited)`;
  return isAtDefault ? 'Default settings' : 'Your settings';
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
  const isAtDefault = isAtPreset(def, instance, {
    name: 'Default',
    source: 'factory',
    params: defaultValues(def.params as ParamSpecs),
    state: def.defaultState,
  });
  // Settings that match a preset count as that preset, so turning a knob shows "(edited)".
  const exactName = exact?.name;
  useEffect(() => {
    if (exactName && s.presets.loadedInto(owner) !== exactName) s.presets.noteLoaded(owner, exactName);
  }, [exactName, owner, s]);
  const userPreset = last?.source === 'user' && last.id ? s.presets.get(last.id) : undefined;

  /** Steps to the next (or previous) preset, wrapping round; from none, down starts at the first and up at the last. */
  const step = (delta: number) => {
    if (choices.length === 0) return;
    const index = last ? choices.indexOf(last) : -1;
    const startWithoutPreset = delta > 0 ? 0 : choices.length - 1;
    const next = index < 0 ? startWithoutPreset : (index + delta + choices.length) % choices.length;
    const choice = choices[next];
    if (choice) applyPreset(s, owner, def, choice);
  };

  const menuContext: PresetMenuContext = { s, owner, def, instance, choices, exact, last, lastName, userPreset, isAtDefault };
  const openMenu = (at: { clientX: number; clientY: number }) => showContextMenu(at, presetMenuEntries(menuContext));
  const saveSuggestion = last && !exact ? `${last.name} 2` : '';

  const hasChoices = choices.length > 0;
  return (
    <div className={styles.bar} data-tour="preset-bar">
      <span className={styles.pill}>
        <button
          type="button"
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
          className={styles.name}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            openMenu({ clientX: box.left, clientY: box.bottom + 2 });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e);
          }}
          data-hint="Presets: load one, save your own, reset or randomize"
        >
          <span className={styles.label}>{presetLabel(exact, lastName, isAtDefault)}</span>
          <span className={styles.caret}>▾</span>
        </button>
        <button
          type="button"
          className={styles.arrow}
          disabled={!hasChoices}
          onClick={() => step(1)}
          data-hint={hasChoices ? 'Next preset' : 'No presets yet'}
          aria-label="Next preset"
        >
          ▶
        </button>
      </span>
      <button type="button" className={styles.save} onClick={() => void savePresetAs(s, owner, def, instance, saveSuggestion)} data-hint="Save these settings as a preset of your own">
        Save…
      </button>
    </div>
  );
}
