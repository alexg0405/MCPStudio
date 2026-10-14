import { useCallback, useSyncExternalStore } from 'react';
import { KIT, KIT_VERSION } from '@core/model/kit';
import { addEffectToSelectedInsert } from '@app/actions/mixer';
import { showContextMenu } from '../../controls/ContextMenu';
import { openWindow } from '../../workspace/registry';
import { addInstrumentChannel, addKitChannel } from '@app/actions/channels';
import { newPattern } from '@app/actions/patterns';
import type { PatternId } from '@core/model/types';
import { useDoc, useServices, useView } from '../../services-context';
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
  const pluginMenu = (ev: React.MouseEvent, id: string, source: 'builtin' | 'user') => {
    ev.preventDefault();
    showContextMenu(ev, [
      ...(source === 'user'
        ? [
            {
              label: 'Edit code',
              onSelect: () => services.commands.run('plugins.editCode', id),
              hint: 'Open its code in your code editor (saving hot-reloads it)',
            },
            { kind: 'separator' as const },
          ]
        : []),
      {
        label: 'New plugin…',
        onSelect: () => services.commands.run('plugins.new'),
        hint: 'Start your own instrument, effect or piano-roll tool from a template',
      },
    ]);
  };
  return (
    <>
      {instruments.map((e) => (
        <button
          key={e.def.id}
          className={styles.item}
          onContextMenu={(ev) => pluginMenu(ev, e.def.id, e.source)}
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
          onContextMenu={(ev) => pluginMenu(ev, e.def.id, e.source)}
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
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-agstudio-sound', k.generator);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          data-hint={`${k.name}: click to preview, double-click to add a channel, drag onto the playlist for an audio clip`}
        >
          {k.name}
        </button>
      ))}
    </>
  );
}

/** The project's patterns: click to edit, drag onto the playlist to place. */
export function ProjectSection() {
  const services = useServices();
  const order = useDoc((p) => p.patternOrder);
  const patterns = useDoc((p) => p.patterns);
  const current = useView((v) => v.currentPatternId);
  return (
    <>
      {order.map((id) => {
        const pat = patterns[id];
        if (!pat) return null;
        return (
          <button
            key={id}
            className={`${styles.item} ${id === current ? styles.itemOn : ''}`}
            onClick={() => services.view.getState().setCurrentPattern(id as PatternId)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-agstudio-pattern', id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            data-hint={`${pat.name}: click to edit, drag onto the playlist to place it`}
          >
            <span className={styles.swatch} style={{ background: pat.color }} />
            {pat.name}
          </button>
        );
      })}
      <button className={styles.item} onClick={() => void newPattern(services)} data-hint="Add an empty pattern (F4)">
        + New pattern
      </button>
    </>
  );
}
