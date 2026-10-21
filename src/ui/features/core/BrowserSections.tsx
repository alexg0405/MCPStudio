import { memo, useCallback, useSyncExternalStore } from 'react';
import { KIT, KIT_VERSION } from '@core/model/kit';
import { addEffectToSelectedInsert } from '@app/actions/mixer';
import { showContextMenu } from '../../controls/ContextMenu';
import { openEffect } from '../rack/open';
import { startEffectDrag } from '../rack/rack-drag';
import { addInstrumentChannel, addKitChannel } from '@app/actions/channels';
import { newPattern } from '@app/actions/patterns';
import { isPatternPlaying } from '@app/actions/transport';
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
            {
              label: 'Share this plugin…',
              onSelect: () => services.commands.run('plugins.share', id),
              hint: 'Save it, with your presets for it, as one .agplugin file to send to a friend',
            },
            { kind: 'separator' as const },
          ]
        : []),
      {
        label: 'Import a plugin…',
        onSelect: () => services.commands.run('plugins.import'),
        hint: 'Install a plugin someone shared (a .agplugin file)',
      },
      {
        label: 'My plugins…',
        onSelect: () => services.commands.run('view.pluginManager'),
        hint: 'List, share, duplicate, switch off or delete your own plugins',
      },
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
          draggable
          onDragStart={(ev) => startEffectDrag(ev, e.def.id)}
          onClick={() => {
            const added = addEffectToSelectedInsert(services, e.def.id);
            if (added) openEffect(services, added.insertId, added.slotId);
          }}
          data-hint={`${e.def.description ?? e.def.name}. Click to add it to the selected mixer insert, or drag it into a branch of a rack.`}
        >
          {e.def.name}
          <span className={styles.badge}>fx</span>
          {e.source === 'user' && <span className={styles.badge}>user</span>}
        </button>
      ))}
      <button
        className={styles.item}
        onClick={() => void services.commands.run('plugins.import')}
        data-hint="Install a plugin someone shared (a .agplugin file). You can also drop the file anywhere on AGstudio."
      >
        Import a plugin…
      </button>
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

/** One pattern in the list. It reads its own name and color, so an edit that makes a new `patterns` object (every note drawn) re-renders nothing here. */
const PatternItem = memo(function PatternItem({ id }: { id: PatternId }) {
  const services = useServices();
  const name = useDoc((p) => p.patterns[id]?.name);
  const color = useDoc((p) => p.patterns[id]?.color);
  const on = useView((v) => v.currentPatternId === id);
  if (name === undefined) return null;
  return (
    <button
      className={`${styles.item} ${on ? styles.itemOn : ''}`}
      aria-current={on || undefined}
      onClick={() => services.view.getState().setCurrentPattern(id)}
      onContextMenu={(e) => {
        e.preventDefault();
        const playing = isPatternPlaying(services, id);
        showContextMenu(e, [
          { kind: 'label', label: name },
          playing
            ? {
                icon: 'stop',
                label: 'Stop',
                hint: 'Stop playing this pattern',
                onSelect: () => void services.commands.run('transport.stop'),
              }
            : {
                icon: 'play',
                label: 'Play',
                hint: 'Play this pattern on a loop (it becomes the pattern you are editing)',
                onSelect: () => void services.commands.run('transport.playPattern', { patternId: id }),
              },
          {
            label: 'Edit',
            hint: 'Make this the pattern the channel rack and piano roll edit',
            onSelect: () => services.view.getState().setCurrentPattern(id),
          },
        ]);
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-agstudio-pattern', id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      data-hint={`${name}: click to edit, right-click to play it, drag onto the playlist to place it`}
    >
      <span className={styles.swatch} style={{ background: color }} />
      {name}
    </button>
  );
});

/** The project's patterns: click to edit, drag onto the playlist to place. */
export function ProjectSection() {
  const services = useServices();
  const order = useDoc((p) => p.patternOrder);
  return (
    <>
      {order.map((id) => (
        <PatternItem key={id} id={id} />
      ))}
      <button className={styles.item} onClick={() => void newPattern(services)} data-hint="Add an empty pattern (F4)">
        + New pattern
      </button>
    </>
  );
}
