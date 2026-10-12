import { createElement, useEffect, type ComponentType } from 'react';
import { KIT } from '@core/model/kit';
import type { ChannelId, PluginOwner } from '@core/model/types';
import { addSample, setChannelProp, setPluginSample } from '@core/ops/channels';
import { keyName } from '@core/time/ppq';
import { resolveValues, type ParamSpecs, type ParamValue, type PluginUIProps } from '@agstudio/sdk';
import { kitSampleRef } from '@app/default-project';
import { useDoc, useServices } from '../../services-context';
import { usePluginDef, usePluginEditing } from '../../plugin-hooks';
import { DragNumber } from '../../controls/DragNumber';
import { ErrorBoundary } from '../../controls/ErrorBoundary';
import { useGestureEdit } from '../../edit';
import { AutoPanel } from './AutoPanel';
import styles from './PluginWindow.module.css';
import type { WindowContentProps } from '../../workspace/registry';

export type PluginWindowProps = { kind: 'channel'; channelId: string };

function SampleSlot({ owner, slot }: { owner: PluginOwner & { kind: 'channel' }; slot: string }) {
  const services = useServices();
  const sampleName = useDoc((p) => {
    const ch = p.channels[owner.channelId];
    const id = ch?.kind === 'instrument' ? ch.plugin.samples?.[slot] : undefined;
    return id ? (p.samples[id]?.name ?? '?') : null;
  });
  return (
    <label
      className={styles.headerItem}
      data-hint="The sample this plugin plays (your own files arrive with the sample browser, M6)"
    >
      <span className={styles.headerLabel}>{slot === 'main' ? 'Sample' : slot}</span>
      <select
        value=""
        onChange={(e) => {
          const piece = KIT.find((k) => k.generator === e.target.value);
          if (!piece) return;
          const ref = kitSampleRef(piece.generator);
          services.history.transact('Change sample', (d) => {
            addSample(d, ref);
            setPluginSample(d, owner, slot, ref.id);
          });
        }}
      >
        <option value="" disabled>
          {sampleName ?? '(empty)'}
        </option>
        {KIT.map((k) => (
          <option key={k.generator} value={k.generator}>
            {k.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function RootKey({ channelId }: { channelId: ChannelId }) {
  const rootKey = useDoc((p) => {
    const ch = p.channels[channelId];
    return ch?.kind === 'instrument' ? ch.rootKey : 60;
  });
  const edit = useGestureEdit<number>(
    'Root note',
    (d, v) => setChannelProp(d, channelId, 'rootKey', Math.round(v)),
    `root:${channelId}`,
  );
  return (
    <span
      className={styles.headerItem}
      data-hint="Root note: step-sequencer notes play this key, and samples play at original pitch here"
    >
      <span className={styles.headerLabel}>Root</span>
      <DragNumber
        className={styles.rootKey}
        value={rootKey}
        min={0}
        max={127}
        perPixel={0.2}
        step={1}
        format={(v) => keyName(Math.round(v))}
        parse={() => null}
        {...edit}
      />
    </span>
  );
}

export function PluginWindow({ windowId, props }: WindowContentProps<PluginWindowProps>) {
  const services = useServices();
  const owner: PluginOwner & { kind: 'channel' } = { kind: 'channel', channelId: props.channelId as ChannelId };
  const instance = useDoc((p) => {
    const ch = p.channels[owner.channelId];
    return ch?.kind === 'instrument' ? ch.plugin : undefined;
  });
  const exists = useDoc((p) => !!p.channels[owner.channelId]);
  const def = usePluginDef(instance?.pluginId);
  const edit = usePluginEditing(owner, def);

  // Close the editor when its channel is deleted.
  useEffect(() => {
    if (!exists) services.view.getState().removeWindow(windowId);
  }, [exists, services, windowId]);

  if (!instance) return null;
  if (!def) {
    return (
      <div className={styles.missing}>
        <strong>Plugin “{instance.pluginId}” isn’t installed.</strong>
        <p>Its settings are kept with the project and come back as soon as the plugin is available again.</p>
      </div>
    );
  }

  const values = resolveValues(def.params as ParamSpecs, instance.params) as Record<string, ParamValue>;
  const Custom = def.ui;
  const uiProps: PluginUIProps = {
    specs: def.params as ParamSpecs,
    values,
    state: instance.state ?? def.defaultState,
    beginEdit: edit.beginEdit,
    setParam: edit.setParam,
    endEdit: edit.endEdit,
    setState: edit.setState,
  };

  return (
    <div className={styles.window}>
      <div className={styles.header}>
        <span className={styles.pluginName} data-hint={def.description ?? def.name}>
          {def.name}
        </span>
        {def.presets && def.presets.length > 0 && (
          <label className={styles.headerItem}>
            <span className={styles.headerLabel}>Preset</span>
            <select
              value=""
              onChange={(e) => {
                const preset = def.presets?.find((pr) => pr.name === e.target.value);
                if (!preset) return;
                const next: Record<string, ParamValue> = {};
                for (const [key, spec] of Object.entries(def.params as ParamSpecs))
                  next[key] = (preset.params as Record<string, ParamValue> | undefined)?.[key] ?? spec.default;
                edit.setParams(next, `${def.name}: ${preset.name}`);
                if (preset.state !== undefined) edit.setState(preset.state);
              }}
            >
              <option value="" disabled>
                Choose…
              </option>
              {def.presets.map((pr) => (
                <option key={pr.name} value={pr.name}>
                  {pr.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <RootKey channelId={owner.channelId} />
        {def.sampleSlots?.map((slot) => (
          <SampleSlot key={slot} owner={owner} slot={slot} />
        ))}
      </div>
      <div className={styles.body}>
        <ErrorBoundary
          resetKey={def}
          fallback={(error) => (
            <div className={styles.missing}>
              <strong>This plugin’s editor crashed.</strong>
              <p className={styles.error}>{error.message}</p>
              <AutoPanel specs={def.params as ParamSpecs} values={values} {...edit} />
            </div>
          )}
        >
          {Custom ? (
            createElement(Custom as unknown as ComponentType<PluginUIProps>, uiProps)
          ) : (
            <AutoPanel specs={def.params as ParamSpecs} values={values} {...edit} />
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
