import { useCallback, useState, useSyncExternalStore } from 'react';
import type { PluginDef } from '@agstudio/sdk';
import { addInstrumentChannel } from '@app/actions/channels';
import { addEffectToSelectedInsert } from '@app/actions/mixer';
import { presetChoices, type PresetChoice } from '@app/presets';
import type { Services } from '@app/services';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import browser from '../../shell/Browser.module.css';
import styles from './Presets.module.css';

/** Adds an instrument preset as a new channel, or an effect preset to the insert selected in the mixer. */
export function addFromPreset(s: Services, def: PluginDef, preset: PresetChoice): void {
  if (def.kind === 'instrument') {
    const id = addInstrumentChannel(s, def.id, preset);
    if (id) openWindow(s, 'plugin', { kind: 'channel', channelId: id });
    return;
  }
  const added = addEffectToSelectedInsert(s, def.id, preset);
  if (added) openWindow(s, 'plugin', { kind: 'fx', ...added });
}

/**
 * Presets in the browser: yours, and a search over every preset of every plugin. Click an
 * instrument preset to add a channel with it, an effect preset to add it to the selected mixer track.
 */
export function PresetsSection() {
  const s = useServices();
  const [query, setQuery] = useState('');
  const subscribe = useCallback(
    (fn: () => void) => {
      const a = s.presets.subscribe(fn);
      const b = s.plugins.subscribe(fn);
      return () => {
        a();
        b();
      };
    },
    [s],
  );
  useSyncExternalStore(subscribe, () => `${s.presets.getVersion()}:${s.plugins.getVersion()}`);

  const all = [...s.plugins.list('instrument'), ...s.plugins.list('effect')].flatMap((e) =>
    presetChoices(e.def, s.presets).map((preset) => ({ def: e.def, preset })),
  );
  const q = query.trim().toLowerCase();
  const shown = q
    ? all
        .filter(({ def, preset }) =>
          `${preset.name} ${def.name} ${def.category ?? ''} ${def.kind}`.toLowerCase().includes(q),
        )
        // Yours first, then by name.
        .sort((a, b) => Number(b.preset.source === 'user') - Number(a.preset.source === 'user'))
        .slice(0, 100)
    : all.filter((x) => x.preset.source === 'user');

  return (
    <>
      <input
        className={styles.search}
        type="search"
        placeholder={`Search ${all.length} presets…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('');
            e.currentTarget.blur();
          }
        }}
        data-hint="Find a sound by name, instrument or effect (e.g. “pad”, “808”, “reverb”)"
      />
      {shown.length === 0 && (
        <div className={browser.empty}>
          {q ? 'No preset matches that.' : 'Your own presets show here: save one with “Save…” in any plugin window. Whole rows of effects are under Chains.'}
        </div>
      )}
      {shown.map(({ def, preset }) => (
        <button
          key={`${def.id}/${preset.source}/${preset.id ?? preset.name}`}
          className={browser.item}
          onClick={() => addFromPreset(s, def, preset)}
          data-hint={
            def.kind === 'instrument'
              ? `${def.name}: “${preset.name}”. Click to add a channel with it.`
              : `${def.name}: “${preset.name}”. Click to add it to the selected mixer track.`
          }
        >
          {preset.source === 'user' && <span className={styles.mine}>★</span>}
          {preset.name}
          <span className={browser.badge}>{def.name}</span>
        </button>
      ))}
    </>
  );
}
