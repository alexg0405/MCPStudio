import { memo, useEffect, useRef, useState } from 'react';
import { KIT } from '@core/model/kit';
import { MASTER, type ChannelId, type PatternId } from '@core/model/types';
import { setChannelProp, toggleSoloChannel } from '@core/ops/channels';
import { setStep, setStepCount, setSwing } from '@core/ops/notes';
import { stepView } from '@core/query/queries';
import { PALETTE } from '@core/model/defaults';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { addInstrumentChannel, addKitChannel, cloneChannel, deleteChannel, moveChannelBy } from '@app/actions/channels';
import type { Services } from '@app/services';
import { useDoc, useServices, useSession, useView } from '../../services-context';
import { usePluginDef } from '../../plugin-hooks';
import { useGestureEdit } from '../../edit';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { DragNumber } from '../../controls/DragNumber';
import { Icon } from '../../controls/Icon';
import { onFrame } from '../../frame-loop';
import styles from './ChannelRack.module.css';

const VOLUME = p.float(0, 1.25, 0.78, { label: 'Volume', unit: '%' });
const PAN = p.float(-1, 1, 0, { label: 'Pan' });
const SWING = p.float(0, 1, 0, { label: 'Swing', unit: '%' });
const STEP_W = 17;
const STEP_GAP = 2;
const GROUP_GAP = 5;

function stepX(i: number): number {
  return i * (STEP_W + STEP_GAP) + Math.floor(i / 4) * (GROUP_GAP - STEP_GAP);
}

/** "Add" entries: kit sounds and instrument plugins. */
export function addChannelMenu(services: Services): MenuEntry[] {
  const instruments = services.plugins.list('instrument');
  return [
    { kind: 'label', label: 'Kit sounds' },
    ...KIT.map((k) => ({ label: k.name, onSelect: () => void addKitChannel(services, k.generator) })),
    { kind: 'separator' },
    { kind: 'label', label: 'Instruments' },
    ...instruments.map((e) => ({
      label: e.source === 'user' ? `${e.def.name} (user)` : e.def.name,
      onSelect: () => void addInstrumentChannel(services, e.def.id),
    })),
  ];
}

// ---- Paint state shared by step grids (FL paints along one row) ----

interface Paint {
  channelId: ChannelId;
  on: boolean;
  done: Set<number>;
  /** Last step painted; fast drags fill every step in between. */
  last: number;
  commit(): void;
  apply(step: number): void;
}

let paint: Paint | null = null;

function beginPaint(
  services: Services,
  patternId: PatternId,
  channelId: ChannelId,
  rootKey: number,
  step: number,
  on: boolean,
) {
  const gesture = services.history.gesture(on ? 'Paint steps' : 'Erase steps');
  const done = new Set<number>();
  paint = {
    channelId,
    on,
    done,
    last: step,
    apply(target) {
      const from = Math.min(this.last, target);
      const to = Math.max(this.last, target);
      this.last = target;
      const todo: number[] = [];
      for (let s = from; s <= to; s++) if (!done.has(s)) todo.push(s);
      if (todo.length === 0) return;
      for (const s of todo) done.add(s);
      gesture.update((d) => {
        for (const s of todo) setStep(d, patternId, channelId, s, on, { rootKey });
      });
    },
    commit: () => gesture.commit(),
  };
  paint.apply(step);
  // Audition the step when turning it on.
  if (on) {
    const id = services.engine.previewNoteOn(channelId, rootKey, 100 / 128);
    setTimeout(() => services.engine.previewNoteOff(channelId, id), 120);
  }
}

function endPaint() {
  paint?.commit();
  paint = null;
}

function paintEnter(channelId: ChannelId, step: number) {
  if (paint && paint.channelId === channelId) paint.apply(step);
}

function StepGrid({
  channelId,
  patternId,
  stepCount,
  rootKey,
}: {
  channelId: ChannelId;
  patternId: PatternId;
  stepCount: number;
  rootKey: number;
}) {
  const services = useServices();
  const notes = useDoc((pr) => pr.patterns[patternId]?.notes[channelId]);
  const view = stepView(notes, stepCount, rootKey);

  useEffect(() => {
    window.addEventListener('pointerup', endPaint);
    window.addEventListener('pointercancel', endPaint);
    return () => {
      window.removeEventListener('pointerup', endPaint);
      window.removeEventListener('pointercancel', endPaint);
    };
  }, []);

  if (!view.isSteps) {
    return (
      <div className={styles.notesBar} data-hint="This channel has piano-roll notes (piano roll arrives in M3)">
        <Icon name="note" size={12} /> notes
      </div>
    );
  }

  const begin = (step: number, on: boolean) => beginPaint(services, patternId, channelId, rootKey, step, on);

  return (
    <div
      className={styles.steps}
      data-steps
      style={{ width: stepX(stepCount - 1) + STEP_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {view.velocities.map((v, i) => (
        <button
          key={i}
          tabIndex={-1}
          className={`${styles.step} ${Math.floor(i / 4) % 2 ? styles.stepB : ''} ${v > 0 ? styles.stepOn : ''}`}
          style={{ left: stepX(i) }}
          onPointerDown={(e) => {
            e.preventDefault();
            if (e.button === 2) begin(i, false);
            else if (e.button === 0) begin(i, v === 0);
          }}
          onPointerEnter={() => paintEnter(channelId, i)}
          data-hint={`Step ${i + 1}. Click or drag to paint, right-click to erase`}
          aria-pressed={v > 0}
          aria-label={`Step ${i + 1}`}
        />
      ))}
    </div>
  );
}

function InsertBox({ channelId }: { channelId: ChannelId }) {
  const order = useDoc((pr) => pr.mixer.order);
  const output = useDoc((pr) => {
    const ch = pr.channels[channelId];
    return ch && ch.kind !== 'automation' ? ch.output : MASTER;
  });
  const index = Math.max(0, order.indexOf(output));
  const edit = useGestureEdit<number>(
    'Route channel',
    (d, v) => setChannelProp(d, channelId, 'output', order[Math.round(v)] ?? MASTER),
    `route:${channelId}`,
  );
  return (
    <DragNumber
      className={styles.insert}
      value={index}
      min={0}
      max={order.length - 1}
      perPixel={0.15}
      step={1}
      format={(v) => (Math.round(v) === 0 ? '--' : String(Math.round(v)))}
      {...edit}
      hint="Mixer insert this channel plays through (-- = master). Drag to change."
    />
  );
}

const ChannelRow = memo(function ChannelRow({
  id,
  patternId,
  stepCount,
}: {
  id: ChannelId;
  patternId: PatternId;
  stepCount: number;
}) {
  const services = useServices();
  const ch = useDoc((pr) => pr.channels[id]);
  const selected = useSession((s) => s.selectedChannelId === id);
  const [renaming, setRenaming] = useState(false);
  const volume = useGestureEdit<number>('Channel volume', (d, v) => setChannelProp(d, id, 'volume', v), `vol:${id}`);
  const pan = useGestureEdit<number>('Channel pan', (d, v) => setChannelProp(d, id, 'pan', v), `pan:${id}`);
  const def = usePluginDef(ch?.kind === 'instrument' ? ch.plugin.pluginId : undefined);
  if (!ch || ch.kind === 'automation') return null;
  const missing = ch.kind === 'instrument' && !def;

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    services.session.getState().selectChannel(id);
    showContextMenu(e, [
      { label: 'Rename…', onSelect: () => setRenaming(true) },
      {
        kind: 'swatches',
        colors: PALETTE,
        selected: ch.color,
        onSelect: (c) => services.history.transact('Channel color', (d) => setChannelProp(d, id, 'color', c)),
      },
      { kind: 'separator' },
      { label: 'Clone', onSelect: () => void cloneChannel(services, id) },
      { label: 'Move up', onSelect: () => moveChannelBy(services, id, -1) },
      { label: 'Move down', onSelect: () => moveChannelBy(services, id, 1) },
      { kind: 'separator' },
      {
        label: ch.solo ? 'Unsolo' : 'Solo',
        onSelect: () => services.history.transact('Solo', (d) => toggleSoloChannel(d, id)),
      },
      { label: 'Delete', danger: true, onSelect: () => deleteChannel(services, id), shortcut: 'Alt+Del' },
    ]);
  };

  return (
    <div className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
      <button
        tabIndex={-1}
        className={`${styles.led} ${ch.muted ? '' : styles.ledOn} ${ch.solo ? styles.ledSolo : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() =>
          services.history.transact(ch.muted ? 'Unmute' : 'Mute', (d) => setChannelProp(d, id, 'muted', !ch.muted))
        }
        onContextMenu={(e) => {
          e.preventDefault();
          services.history.transact('Solo', (d) => toggleSoloChannel(d, id));
        }}
        data-hint={`${ch.name}: ${ch.muted ? 'muted' : 'on'}. Click to mute, right-click to solo`}
        aria-label={ch.muted ? 'Unmute' : 'Mute'}
      />
      <Knob spec={PAN} value={ch.pan} size={20} bipolar label="Pan" {...pan} />
      <Knob spec={VOLUME} value={ch.volume} size={20} label="Volume" {...volume} />
      <InsertBox channelId={id} />
      {renaming ? (
        <input
          className={styles.rename}
          autoFocus
          defaultValue={ch.name}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            setRenaming(false);
            const name = e.currentTarget.value.trim();
            if (name && name !== ch.name)
              services.history.transact('Rename channel', (d) => setChannelProp(d, id, 'name', name));
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = ch.name;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          tabIndex={-1}
          className={`${styles.name} ${missing ? styles.nameMissing : ''}`}
          style={{ ['--ch-color' as string]: ch.color }}
          onPointerDown={(e) => {
            e.preventDefault();
            if (e.button === 0) services.session.getState().selectChannel(id);
          }}
          onDoubleClick={() => services.commands.run('plugin.openEditor', { channelId: id })}
          onContextMenu={menu}
          data-hint={
            missing
              ? `${ch.name}: plugin "${ch.kind === 'instrument' ? ch.plugin.pluginId : ''}" is not installed (settings are kept)`
              : `${ch.name}${def ? ` (${def.name})` : ''}. Double-click to open, right-click for options`
          }
        >
          {ch.name}
        </button>
      )}
      {ch.kind === 'instrument' ? (
        <StepGrid channelId={id} patternId={patternId} stepCount={stepCount} rootKey={ch.rootKey} />
      ) : (
        <div className={styles.notesBar}>audio clip</div>
      )}
      <span className={`${styles.select} ${selected ? styles.selectOn : ''}`} />
    </div>
  );
});

/** Lights the step being played (moved on the frame loop, never through React). */
function StepLight({ stepCount }: { stepCount: number }) {
  const services = useServices();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let last = -1;
    return onFrame(() => {
      const el = ref.current;
      if (!el) return;
      const playing = services.engine.playing && services.view.getState().mode === 'pattern';
      const step = playing ? Math.floor(services.engine.playhead() / 240) : -1;
      const visible = step >= 0 && step < stepCount ? step : -1;
      if (visible === last) return;
      last = visible;
      el.style.opacity = visible < 0 ? '0' : '1';
      // The step column's offset is measured from the first row so CSS stays the source of truth.
      const steps = el.parentElement?.querySelector<HTMLElement>('[data-steps]');
      if (visible >= 0) el.style.transform = `translateX(${(steps?.offsetLeft ?? 0) + stepX(visible)}px)`;
    });
  }, [services, stepCount]);
  return <div ref={ref} className={styles.stepLight} style={{ width: STEP_W, opacity: 0 }} />;
}

export function ChannelRack() {
  const services = useServices();
  const order = useDoc((pr) => pr.channelOrder);
  const patternId = useView((s) => s.currentPatternId);
  const pattern = useDoc((pr) => (patternId ? pr.patterns[patternId] : undefined));
  const swing = useDoc((pr) => pr.transport.swing);
  const swingEdit = useGestureEdit<number>('Swing', (d, v) => setSwing(d, v), 'swing');

  if (!patternId || !pattern) return <div className={styles.empty}>No pattern</div>;
  const stepCount = pattern.stepCount;

  return (
    <div className={styles.rack}>
      <div className={styles.header}>
        <span className={styles.patternName} data-hint="Current pattern (pattern picker arrives in M4)">
          {pattern.name}
        </span>
        <label className={styles.headerControl} data-hint="Number of steps in this pattern">
          Steps
          <select
            value={stepCount}
            onChange={(e) =>
              services.history.transact('Pattern steps', (d) => setStepCount(d, patternId, Number(e.target.value)))
            }
          >
            {[8, 16, 24, 32, 48, 64].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.headerControl}>
          <Knob spec={SWING} value={swing} size={20} label="Swing" {...swingEdit} />
          Swing
        </span>
      </div>
      <div className={styles.scroll}>
        <div className={styles.rows} style={{ minWidth: 250 + stepX(stepCount - 1) + STEP_W }}>
          {order.map((id) => (
            <ChannelRow key={id} id={id} patternId={patternId} stepCount={stepCount} />
          ))}
          <StepLight stepCount={stepCount} />
          <div className={styles.addRow}>
            <button
              tabIndex={-1}
              className={styles.addButton}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => showContextMenu(e, addChannelMenu(services))}
              data-hint="Add a channel (kit sound or instrument)"
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
