import { targetName } from '@core/automation/labels';
import { targetKey } from '@core/model/targets';
import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { KIT, kitPiece } from '@core/model/kit';
import { MASTER, type ChannelId, type PatternId } from '@core/model/types';
import { setChannelProp, toggleSoloChannel } from '@core/ops/channels';
import { setStep, setStepCount, setSwing } from '@core/ops/notes';
import { stepView } from '@core/query/queries';
import { patternTickAt } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { PALETTE } from '@core/model/defaults';
import { p, type ParamSpecs } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { addInstrumentChannel, addKitChannel, cloneChannel, deleteChannel, moveChannelBy } from '@app/actions/channels';
import { addSampleChannels, importAudioFile, setChannelSample } from '@app/actions/samples';
import { kitSampleRef } from '@app/default-project';
import type { Services } from '@app/services';
import { useDoc, useServices, useSession, useView } from '../../services-context';
import { usePluginDef } from '../../plugin-hooks';
import { useWindowedRows } from '../../controls/windowed';
import { useGestureEdit } from '../../edit';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { DragNumber } from '../../controls/DragNumber';
import { parseTypedNumber } from '../../controls/number-text';
import { Icon } from '../../controls/Icon';
import { onFrame } from '../../frame-loop';
import { dragMayHaveAudio, takeAudioFiles } from '../../audio-drag';
import { openWindow } from '../../workspace/registry';
import { MiniRoll } from './MiniRoll';
import { PatternPicker } from '../patterns/PatternPicker';
import { PlayPatternButton } from '../transport/PlayPatternButton';
import { STEP_W, stepX } from './layout';
import { StepGraph } from './StepGraph';
import { stepsMenu, stepTarget, toggleGraph } from './steps';
import styles from './ChannelRack.module.css';

const VOLUME = p.float(0, 1.25, 0.78, { label: 'Volume', unit: '%' });
const PAN = p.float(-1, 1, 0, { label: 'Pan' });
const SWING = p.float(0, 1, 0, { label: 'Swing', unit: '%' });

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

function paintEnter(channelId: ChannelId, step: number, buttons: number) {
  // The button was let go where no pointerup reached us (outside the window): that ends the paint.
  if (paint && buttons === 0) endPaint();
  if (paint && paint.channelId === channelId) paint.apply(step);
}

/** Which steps are on, as "0100…": all the step buttons show, so a row whose steps did not change skips rendering. */
const stepBits = (() => {
  const cache = new WeakMap<object, string>();
  return (view: ReturnType<typeof stepView>): string => {
    let bits = cache.get(view);
    if (bits === undefined) {
      bits = view.velocities.map((v) => (v > 0 ? '1' : '0')).join('');
      cache.set(view, bits);
    }
    return bits;
  };
})();

/**
 * The buttons of one row's steps. They carry no handlers (the grid handles pointer events for all of
 * them) and their only prop is which steps are on, so switching patterns re-renders just the rows whose
 * steps differ.
 */
const StepButtons = memo(function StepButtons({ on }: { on: string }) {
  return (
    <>
      {Array.from(on, (bit, i) => (
        <button
          key={i}
          tabIndex={-1}
          className={`${styles.step} ${Math.floor(i / 4) % 2 ? styles.stepB : ''} ${bit === '1' ? styles.stepOn : ''}`}
          style={{ left: stepX(i) }}
          data-step={i}
          data-hint={`Step ${i + 1}. Click or drag to paint, right-click to erase`}
          aria-pressed={bit === '1'}
          aria-label={`Step ${i + 1}`}
        />
      ))}
    </>
  );
});

/** The step button under a pointer event, and whether it is on. */
function stepUnder(e: React.PointerEvent): { index: number; on: boolean } | null {
  const button = (e.target as Element).closest<HTMLElement>('[data-step]');
  return button ? { index: Number(button.dataset.step), on: button.getAttribute('aria-pressed') === 'true' } : null;
}

function StepGrid({ channelId, rootKey }: { channelId: ChannelId; rootKey: number }) {
  const services = useServices();
  const patternId = useView((s) => s.currentPatternId);
  const stepCount = useDoc((pr) => (patternId ? pr.patterns[patternId]?.stepCount : undefined)) ?? 16;
  const notes = useDoc((pr) => (patternId ? pr.patterns[patternId]?.notes[channelId] : undefined));
  const view = stepView(notes, stepCount);
  if (!patternId) return null;

  if (!view.isSteps) {
    return (
      <div className={styles.steps} data-steps style={{ width: stepX(stepCount - 1) + STEP_W }}>
        <MiniRoll channelId={channelId} patternId={patternId} width={stepX(stepCount - 1) + STEP_W} />
      </div>
    );
  }

  return (
    <div
      className={styles.steps}
      data-steps
      style={{ width: stepX(stepCount - 1) + STEP_W }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        const step = stepUnder(e);
        if (!step) return;
        e.preventDefault();
        if (e.button === 2) beginPaint(services, patternId, channelId, rootKey, step.index, false);
        else if (e.button === 0) beginPaint(services, patternId, channelId, rootKey, step.index, !step.on);
      }}
      onPointerOver={(e) => {
        const step = stepUnder(e);
        if (step) paintEnter(channelId, step.index, e.buttons);
      }}
    >
      <StepButtons on={stepBits(view)} />
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
      // “--”, “0” or “master” is the master; a number is that insert.
      parse={(t) => (/^\s*(--?|m(aster)?)\s*$/i.test(t) ? 0 : parseTypedNumber(t))}
      editText={(v) => String(Math.round(v))}
      {...edit}
      hint="Mixer insert this channel plays through (-- = master): drag, scroll, or click to type its number"
      editHint="Type a mixer insert number (0 or -- = master) · Enter sets it, Esc cancels"
      label="Mixer insert"
    />
  );
}

const SOUND = 'application/x-agstudio-sound';

/**
 * FL behaviour for drops on the rack: a sound dropped on a sampler (or audio clip) channel replaces
 * its sample; anywhere else, or several files at once, adds new channels.
 */
async function dropOnRack(
  s: Services,
  target: ChannelId | undefined,
  generator: string,
  files: Promise<File[]> | null,
): Promise<void> {
  if (generator) {
    const ref = { ...kitSampleRef(generator), name: kitPiece(generator)?.short ?? generator };
    if (!target || !setChannelSample(s, target, ref)) addKitChannel(s, generator);
    return;
  }
  const refs = [];
  for (const file of (await files) ?? []) {
    const ref = await importAudioFile(s, file);
    if (ref) refs.push(ref);
  }
  const [first] = refs;
  if (!first) return;
  if (target && refs.length === 1 && setChannelSample(s, target, first)) return;
  const order = s.doc.getState().project.channelOrder;
  addSampleChannels(s, refs, target ? order.indexOf(target) + 1 : order.length);
}

/**
 * One channel's row. It takes no pattern: the step grid inside follows the open pattern itself, so
 * switching patterns doesn't re-render the knobs, names and routing of every channel.
 */
const ChannelRow = memo(function ChannelRow({ id, dropTarget }: { id: ChannelId; dropTarget: boolean }) {
  const services = useServices();
  const ch = useDoc((pr) => pr.channels[id]);
  const selected = useSession((s) => s.selectedChannelId === id);
  const [renaming, setRenaming] = useState(false);
  const volume = useGestureEdit<number>('Channel volume', (d, v) => setChannelProp(d, id, 'volume', v), `vol:${id}`);
  const pan = useGestureEdit<number>('Channel pan', (d, v) => setChannelProp(d, id, 'pan', v), `pan:${id}`);
  const def = usePluginDef(ch?.kind === 'instrument' ? ch.plugin.pluginId : undefined);
  if (!ch) return null;
  if (ch.kind === 'automation') return <AutomationRow id={id} />;
  const missing = ch.kind === 'instrument' && !def;

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    services.session.getState().selectChannel(id);
    showContextMenu(e, [
      {
        label: 'Piano roll',
        shortcut: 'F7',
        onSelect: () => {
          services.session.getState().selectChannel(id);
          openWindow(services, 'piano-roll');
        },
      },
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
      ...extraMenuItems('rack.channel', { channelId: id }, services),
      { kind: 'separator' },
      { label: 'Delete', danger: true, onSelect: () => deleteChannel(services, id), shortcut: 'Alt+Del' },
    ]);
  };

  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${dropTarget ? styles.rowDrop : ''}`}
      data-channel-id={id}
    >
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
      <Knob
        spec={PAN}
        value={ch.pan}
        size={20}
        bipolar
        label="Pan"
        param={targetKey({ kind: 'channel', channelId: id, param: 'pan' })}
        {...pan}
      />
      <Knob
        spec={VOLUME}
        value={ch.volume}
        size={20}
        label="Volume"
        param={targetKey({ kind: 'channel', channelId: id, param: 'volume' })}
        {...volume}
      />
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
        <StepGrid channelId={id} rootKey={ch.rootKey} />
      ) : (
        <div className={styles.notesBar}>audio clip</div>
      )}
      <span className={`${styles.select} ${selected ? styles.selectOn : ''}`} />
    </div>
  );
});

/**
 * An automation channel (FL lists them in the rack too): what it moves, and the way to its clips
 * in the playlist, where it is drawn and edited.
 */
function AutomationRow({ id }: { id: ChannelId }) {
  const services = useServices();
  const ch = useDoc((pr) => pr.channels[id]);
  const what = useDoc((pr) => {
    const c = pr.channels[id];
    if (c?.kind !== 'automation' || !c.target) return null;
    return targetName(pr, c.target, (pluginId) => {
      const def = services.plugins.get(pluginId);
      return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
    });
  });
  // Where it plays: "bars 1–5", or the first of several clips.
  const where = useDoc((pr) => {
    const clips = Object.values(pr.playlist.clips)
      .filter((c) => c.kind === 'automation' && c.channelId === id)
      .sort((a, b) => a.start - b.start);
    const first = clips[0];
    if (!first) return null;
    const bar = ticksPerBar(pr.transport.timeSig);
    const from = Math.round((first.start / bar + 1) * 100) / 100;
    const to = Math.round(((first.start + first.length) / bar + 1) * 100) / 100;
    return `bars ${from}–${to}${clips.length > 1 ? ` (+${clips.length - 1} more)` : ''}`;
  });
  if (ch?.kind !== 'automation') return null;
  const reveal = () => {
    const clips = Object.values(services.doc.getState().project.playlist.clips)
      .filter((c) => c.kind === 'automation' && c.channelId === id)
      .map((c) => c.id);
    services.editor.getState().selectClips(clips);
    openWindow(services, 'playlist');
  };
  const toggleMute = () =>
    services.history.transact(ch.muted ? 'Unmute automation' : 'Mute automation', (d) =>
      setChannelProp(d, id, 'muted', !ch.muted),
    );
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu(e, [
      { label: 'Show it in the playlist', onSelect: reveal },
      {
        label: ch.muted ? 'Unmute (let it move the control again)' : 'Mute (stop moving the control)',
        onSelect: toggleMute,
      },
      { kind: 'separator' },
      { label: 'Delete this automation', danger: true, onSelect: () => deleteChannel(services, id) },
    ]);
  };
  const subject = what ? `automation of “${what}”` : 'automation of a control that no longer exists';
  return (
    <div className={styles.row} data-channel-id={id}>
      <button
        tabIndex={-1}
        className={`${styles.led} ${ch.muted ? '' : styles.ledOn}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={toggleMute}
        data-hint={`${ch.name}: ${ch.muted ? 'muted' : 'on'}. Click to ${ch.muted ? 'let it move the control again' : 'mute it'}`}
        aria-label={ch.muted ? 'Unmute' : 'Mute'}
      />
      <span className={styles.autoSpacer} />
      <button
        tabIndex={-1}
        className={styles.name}
        style={{ ['--ch-color' as string]: ch.color }}
        onPointerDown={(e) => e.preventDefault()}
        onDoubleClick={reveal}
        onContextMenu={menu}
        data-hint={`${ch.name}: ${subject}. Double-click to show it in the playlist, right-click for options`}
      >
        {ch.name}
      </button>
      <div
        className={`${styles.notesBar} ${styles.autoBar}`}
        onDoubleClick={reveal}
        data-hint="Automation plays from its clips on the playlist (in Song mode). Double-click to show them"
      >
        <Icon name="wave" size={14} />
        {where ? `On the playlist: ${where}` : 'Not on the playlist yet'}
        {what && what !== ch.name ? ` · moves ${what}` : ''}
      </div>
    </div>
  );
}

/** Lights the step being played (moved on the frame loop, never through React). */
function StepLight({ stepCount }: { stepCount: number }) {
  const services = useServices();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let last = -1;
    // Where the step column starts: read once (and again after a resize), since offsetLeft forces a layout.
    let columnLeft = -1;
    const ro = new ResizeObserver(() => (columnLeft = -1));
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    const stop = onFrame(() => {
      const el = ref.current;
      if (!el) return;
      const v = services.view.getState();
      let step = -1;
      if (services.engine.playing && v.currentPatternId) {
        const tick =
          v.mode === 'pattern'
            ? services.engine.playhead()
            : patternTickAt(services.doc.getState().project, services.engine.playhead(), v.currentPatternId);
        if (tick !== null) step = Math.floor(tick / 240);
      }
      const visible = step >= 0 && step < stepCount ? step : -1;
      if (visible === last) return;
      last = visible;
      el.style.opacity = visible < 0 ? '0' : '1';
      // The step column's offset is measured from the first row so CSS stays the source of truth.
      if (visible >= 0) {
        if (columnLeft < 0) columnLeft = el.parentElement?.querySelector<HTMLElement>('[data-steps]')?.offsetLeft ?? -1;
        el.style.transform = `translateX(${Math.max(0, columnLeft) + stepX(visible)}px)`;
      }
    });
    return () => {
      stop();
      ro.disconnect();
    };
  }, [services, stepCount]);
  return <div ref={ref} className={styles.stepLight} style={{ width: STEP_W, opacity: 0 }} />;
}

/**
 * The rack's header: play, pattern, steps, swing and the tools of the selected channel. It follows the selection
 * itself, so selecting a channel (every right-click and double-click does) re-renders this and not the rows.
 */
function RackHeader({ patternId, stepCount }: { patternId: PatternId; stepCount: number }) {
  const services = useServices();
  const swing = useDoc((pr) => pr.transport.swing);
  const swingEdit = useGestureEdit<number>('Swing', (d, v) => setSwing(d, v), 'swing');
  const graphChannel = useStore(services.editor, (s) => s.stepGraph.channelId);
  const selected = useSession((s) => s.selectedChannelId);
  const selectedName = useDoc((pr) => {
    const ch = selected ? pr.channels[selected] : undefined;
    return ch?.kind === 'instrument' ? ch.name : null;
  });
  const menuBelow = (e: React.MouseEvent<HTMLElement>, items: MenuEntry[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  };
  const noChannel = 'Select an instrument channel first (click its name)';
  return (
    <div className={styles.header}>
      <PlayPatternButton
        patternId={patternId}
        className={`${styles.headerButton} ${styles.playButton}`}
        onClassName={styles.headerButtonOn}
      />
      <PatternPicker compact />
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
      <button
        tabIndex={-1}
        className={styles.headerButton}
        disabled={!selectedName}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => menuBelow(e, stepsMenu(services, selected))}
        data-hint={
          selectedName
            ? `Step tools for ${selectedName}: fill every 2, 4 or 8 steps, rotate, shift, reverse, randomize or clear`
            : noChannel
        }
      >
        Steps ▾
      </button>
      <button
        tabIndex={-1}
        className={`${styles.headerButton} ${selected && graphChannel === selected ? styles.headerButtonOn : ''}`}
        disabled={!selectedName}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => selected && stepTarget(services, selected) && toggleGraph(services, selected)}
        data-hint={
          selectedName
            ? `Graph editor: a row under ${selectedName} to draw each step’s velocity, pan, release, pitch or fine pitch`
            : noChannel
        }
      >
        Graph editor
      </button>
    </div>
  );
}

/** One channel row: 30 px and a 2 px gap (the CSS of `.row`); a long rack keeps only the rows near the viewport. */
const ROW_PITCH = 32;

/** The channel rows, the add button and the step light. */
function RackRows({ patternId, stepCount }: { patternId: PatternId; stepCount: number }) {
  const services = useServices();
  const order = useDoc((pr) => pr.channelOrder);
  /** Where a drag would drop: a channel, or the end of the rack ('new'). */
  const [dropTarget, setDropTarget] = useState<ChannelId | 'new' | null>(null);
  const graphChannel = useStore(services.editor, (s) => s.stepGraph.channelId);
  // A long rack (150 channels in a long song) renders only the rows near the viewport, so opening the rack and
  // switching patterns cost what a screenful costs. With the step graph open a row is taller than the rest:
  // every row renders then.
  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(scrollRef, order.length, ROW_PITCH, { overscan: 10 });
  const windowed = graphChannel === null;
  const first = windowed ? win.first : 0;
  const last = windowed ? win.last : order.length;
  const targetOf = (e: React.DragEvent) =>
    (e.target as Element).closest<HTMLElement>('[data-channel-id]')?.dataset.channelId as ChannelId | undefined;

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      onScroll={win.onScroll}
      onDragOver={(e) => {
        const dt = e.dataTransfer;
        if (!dt.types.includes(SOUND) && !dragMayHaveAudio(dt)) return;
        e.preventDefault();
        dt.dropEffect = 'copy';
        const target = targetOf(e) ?? 'new';
        if (target !== dropTarget) setDropTarget(target);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
      }}
      onDrop={(e) => {
        setDropTarget(null);
        const generator = e.dataTransfer.getData(SOUND);
        // Read during the event: the DataTransfer is emptied afterwards.
        const files = generator ? null : takeAudioFiles(e.dataTransfer);
        if (!generator && !files) return;
        e.preventDefault();
        void dropOnRack(services, targetOf(e), generator, files);
      }}
    >
      <div className={styles.rows} style={{ minWidth: 250 + stepX(stepCount - 1) + STEP_W }}>
        {windowed && win.padTop > 0 && <div aria-hidden style={{ height: win.padTop }} />}
        {order.slice(first, last).map((id) => (
          <Fragment key={id}>
            <ChannelRow id={id} dropTarget={dropTarget === id} />
            {graphChannel === id && <StepGraph channelId={id} patternId={patternId} stepCount={stepCount} />}
          </Fragment>
        ))}
        {windowed && win.padBottom > 0 && <div aria-hidden style={{ height: win.padBottom }} />}
        <StepLight stepCount={stepCount} />
        {order.length === 0 && (
          <div className={styles.empty}>
            No sounds yet. Click the + below to add a kit sound or an instrument, or drag a sample here from the
            browser.
          </div>
        )}
        <div className={`${styles.addRow} ${dropTarget === 'new' ? styles.addRowDrop : ''}`}>
          <button
            tabIndex={-1}
            className={styles.addButton}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => showContextMenu(e, addChannelMenu(services))}
            data-hint="Add a channel (kit sound or instrument)"
            aria-label="Add a channel"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChannelRack() {
  const patternId = useView((s) => s.currentPatternId);
  // Only the step count, not the pattern: a step click makes a new pattern object, and the rack (150 rows in a long
  // song) re-rendered on every one only to find that every row is unchanged.
  const stepCountOf = useDoc((pr) => (patternId ? pr.patterns[patternId]?.stepCount : undefined));
  // Letting go anywhere ends a paint along a row.
  useEffect(() => {
    window.addEventListener('pointerup', endPaint);
    window.addEventListener('pointercancel', endPaint);
    return () => {
      window.removeEventListener('pointerup', endPaint);
      window.removeEventListener('pointercancel', endPaint);
    };
  }, []);

  if (!patternId || stepCountOf === undefined)
    return (
      <div className={styles.empty}>
        No pattern is open. Pick one under Project patterns in the browser, or click “+ New pattern” there.
      </div>
    );

  return (
    <div className={styles.rack}>
      <RackHeader patternId={patternId} stepCount={stepCountOf} />
      <RackRows patternId={patternId} stepCount={stepCountOf} />
    </div>
  );
}
