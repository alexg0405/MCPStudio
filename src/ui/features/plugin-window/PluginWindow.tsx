import { createElement, useCallback, useEffect, useMemo, type ComponentType } from 'react';
import { KIT } from '@core/model/kit';
import type { ChannelId, InsertId, PluginOwner, SlotId } from '@core/model/types';
import { addSample, setChannelProp, setPluginSample } from '@core/ops/channels';
import { setFxSlotEnabled } from '@core/ops/mixer';
import { fxSlotOf, pluginInstanceOf } from '@core/query/mixer';
import { keyName, parseKeyName } from '@core/time/ppq';
import { resolveValues, type ParamSpecs, type ParamValue, type PluginUIProps } from '@agstudio/sdk';
import {
  FrameContext,
  ParamFollowContext,
  ParamMenuContext,
  ParamStatusContext,
  type ParamStatus,
} from '@agstudio/sdk/ui';
import { targetKey } from '@core/model/targets';
import { followersOf } from '../../HostParamMenus';
import { kitSampleRef } from '@app/default-project';
import { useDoc, useServices } from '../../services-context';
import { usePluginDef, usePluginEditing } from '../../plugin-hooks';
import { DragNumber } from '../../controls/DragNumber';
import { ErrorBoundary } from '../../controls/ErrorBoundary';
import { useGestureEdit } from '../../edit';
import { showParamMenu } from '../../param-menu';
import { onFrame } from '../../frame-loop';
import { AutoPanel } from './AutoPanel';
import { Meters } from './Meters';
import { usePluginSamples } from './plugin-samples';
import { PresetBar } from './PresetBar';
import styles from './PluginWindow.module.css';
import type { WindowContentProps } from '../../workspace/registry';

/** A channel's instrument, or the effect in a mixer insert's slot. */
export type PluginWindowProps =
  { kind: 'channel'; channelId: string } | { kind: 'fx'; insertId: string; slotId: string };

function ownerOf(props: PluginWindowProps): PluginOwner {
  return props.kind === 'fx'
    ? { kind: 'fx', insertId: props.insertId as InsertId, slotId: props.slotId as SlotId }
    : { kind: 'channel', channelId: props.channelId as ChannelId };
}

function SampleSlot({ owner, slot }: { owner: PluginOwner; slot: string }) {
  const services = useServices();
  const sampleName = useDoc((p) => {
    const id = pluginInstanceOf(p, owner)?.samples?.[slot];
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
        parse={parseKeyName}
        editText={(v) => keyName(Math.round(v))}
        {...edit}
        hint="Root note: drag, scroll, or click to type a note (C5 is middle C) or a key number"
        editHint="Type a note like C5, F#4 or Bb3 (or a key number 0–127) · Enter sets it, Esc cancels"
        label="Root note"
      />
    </span>
  );
}

/** Bypass switch for an effect slot (the host owns it; effects don't implement bypass themselves). */
function SlotPower({ insertId, slotId, name }: { insertId: InsertId; slotId: SlotId; name: string }) {
  const services = useServices();
  const enabled = useDoc((p) => fxSlotOf(p, insertId, slotId)?.enabled ?? false);
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`${styles.power} ${enabled ? styles.powerOn : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() =>
        services.history.transact(`${enabled ? 'Bypass' : 'Enable'} ${name}`, (d) =>
          setFxSlotEnabled(d, insertId, slotId, !enabled),
        )
      }
      data-hint={`${name} is ${enabled ? 'on' : 'bypassed'}. Click to ${enabled ? 'bypass' : 'enable'} it`}
      aria-pressed={enabled}
    >
      <i className={styles.powerLed} />
      {enabled ? 'On' : 'Bypassed'}
    </button>
  );
}

export function PluginWindow({ windowId, props }: WindowContentProps<PluginWindowProps>) {
  const services = useServices();
  const owner = useMemo(() => ownerOf(props), [props]);
  const instance = useDoc((p) => pluginInstanceOf(p, owner));
  const def = usePluginDef(instance?.pluginId);
  const edit = usePluginEditing(owner, def);
  const samples = usePluginSamples(owner, def);
  // The running instance's audio for custom editors (stable while the window shows this owner).
  const tap = useMemo(() => services.taps.view(owner), [services, owner]);
  // Knobs show when an automation clip drives their param.
  const status = useCallback(
    (param: string, cb: (s: ParamStatus | null) => void) =>
      services.automation.watch(targetKey({ kind: 'plugin', owner, paramId: param }), cb),
    [services, owner],
  );

  // Close the editor when its channel or effect slot is deleted.
  useEffect(() => {
    if (!instance) services.view.getState().removeWindow(windowId);
  }, [instance, services, windowId]);

  if (!instance) return null;
  if (!def) {
    return (
      <div className={styles.missing}>
        <strong>Plugin “{instance.pluginId}” isn’t installed.</strong>
        <p>
          Its settings are kept with the project and come back as soon as the plugin is available again.
          {owner.kind === 'fx' && ' Until then the effect slot passes audio through unchanged.'}
        </p>
      </div>
    );
  }

  const values = resolveValues(def.params as ParamSpecs, instance.params) as Record<string, ParamValue>;
  const Custom = def.ui;
  const openParamMenu = (param: string, at: { clientX: number; clientY: number }) => {
    const spec = (def.params as ParamSpecs)[param];
    if (!spec) return;
    showParamMenu(
      at,
      {
        target: { kind: 'plugin', owner, paramId: param },
        spec,
        label: `${def.name} · ${spec.label ?? param}`,
        reset: () => edit.setParam(param, spec.default),
      },
      services,
    );
  };
  const follow = (param: string, paint: (v: ParamValue | null) => void) => {
    const spec = (def.params as ParamSpecs)[param];
    if (!spec) return () => {};
    return followersOf(services).follow(targetKey({ kind: 'plugin', owner, paramId: param }), spec, paint);
  };
  // Instruments can play notes from their editor (pads, slice previews).
  const playNote =
    owner.kind === 'channel'
      ? (key: number, velocity = 0.8) => {
          const noteId = services.engine.previewNoteOn(owner.channelId, key, velocity);
          return () => services.engine.previewNoteOff(owner.channelId, noteId);
        }
      : undefined;
  const uiProps: PluginUIProps = {
    specs: def.params as ParamSpecs,
    values,
    state: instance.state ?? def.defaultState,
    beginEdit: edit.beginEdit,
    setParam: edit.setParam,
    endEdit: edit.endEdit,
    setState: edit.setState,
    openParamMenu,
    samples,
    playNote,
    tap,
  };

  return (
    <div className={styles.window}>
      <div className={styles.header}>
        <span className={styles.pluginName} data-hint={def.description ?? def.name}>
          {def.name}
        </span>
        {owner.kind === 'fx' && <SlotPower insertId={owner.insertId} slotId={owner.slotId} name={def.name} />}
        <PresetBar owner={owner} def={def} instance={instance} />
        {services.plugins.entry(def.id)?.source === 'user' && (
          <button
            type="button"
            tabIndex={-1}
            className={styles.editCode}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => services.commands.run('plugins.editCode', def.id)}
            data-hint="Open this plugin’s code in your code editor: every save hot-reloads it, settings stay"
          >
            {'</>'} Edit code
          </button>
        )}
        {owner.kind === 'channel' && <RootKey channelId={owner.channelId} />}
        {def.samplePickers !== false &&
          def.sampleSlots?.map((slot) => <SampleSlot key={slot} owner={owner} slot={slot} />)}
      </div>
      <div className={styles.body}>
        <ParamMenuContext.Provider value={openParamMenu}>
          <ParamFollowContext.Provider value={follow}>
            <ParamStatusContext.Provider value={status}>
              <FrameContext.Provider value={onFrame}>
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
                  <>
                    {def.meters && def.meters.length > 0 && <Meters meters={def.meters} tap={tap} />}
                    <AutoPanel specs={def.params as ParamSpecs} values={values} {...edit} />
                  </>
                )}
              </ErrorBoundary>
              </FrameContext.Provider>
            </ParamStatusContext.Provider>
          </ParamFollowContext.Provider>
        </ParamMenuContext.Provider>
      </div>
    </div>
  );
}
