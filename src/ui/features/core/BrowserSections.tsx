import { useCallback, useSyncExternalStore } from 'react';
import { KIT, KIT_VERSION } from '@core/model/kit';
import { addEffectToSelectedInsert } from '@app/actions/mixer';
import { openWindow } from '../../workspace/registry';
import { addInstrumentChannel, addKitChannel } from '@app/actions/channels';
import { useServices } from '../../services-context';
import styles from '../../shell/Browser.module.css';

function usePlugins() {
  const { plugins } = useServices();
  const subscribe = useCallback((fn: () => void) => plugins.subscribe(fn), [plugins]);
  useSyncExternalStore(subscribe, () => plugins.getVersion());
  return plugins;
}

/**
 * Instruments and effects (built-in and user). Click an instrument to add it as a channel, an
 * effect to add it to the insert selected in the mixer.
 */
export function PluginsSection() {
  const services = useServices();
  const plugins = usePlugins();
  const instruments = plugins.list('instrument');
  const effects = plugins.list('effect');
  const errors = plugins.loadErrors();
  return (
    <>
      {instruments.map((e) => (
        <button
          key={e.def.id}
          className={styles.item}
          onClick={() => void addInstrumentChannel(services, e.def.id)}
          data-hint={`${e.def.description ?? e.def.name}. Click to add a channel.`}
        >
          {e.def.name}
          {e.source === 'user' && <span className={styles.badge}>user</span>}
        </button>
      ))}
      {effects.map((e) => (
        <button
          key={e.def.id}
          className={styles.item}
          onClick={() => {
            const added = addEffectToSelectedInsert(services, e.def.id);
            if (added) openWindow(services, 'plugin', { kind: 'fx', ...added });
          }}
          data-hint={`${e.def.description ?? e.def.name}. Click to add it to the selected mixer insert.`}
        >
          {e.def.name}
          <span className={styles.badge}>fx</span>
          {e.source === 'user' && <span className={styles.badge}>user</span>}
        </button>
      ))}
      {errors.map((err) => (
        <div key={err.path} className={styles.error} title={err.error} data-hint={err.error}>
          ⚠ {err.path.split('/').slice(-2, -1)[0] ?? err.path}: {err.error}
        </div>
      ))}
    </>
  );
}

/** The built-in procedural drum kit. Click to preview, double-click to add as a channel. */
export function SoundsSection() {
  const services = useServices();
  return (
    <>
      {KIT.map((k) => (
        <button
          key={k.generator}
          className={styles.item}
          onClick={() =>
            services.engine.previewSample({
              name: k.name,
              source: { kind: 'builtin', generator: k.generator, version: KIT_VERSION },
            })
          }
          onDoubleClick={() => void addKitChannel(services, k.generator)}
          data-hint={`${k.name}: click to preview, double-click to add a channel`}
        >
          {k.name}
        </button>
      ))}
    </>
  );
}
