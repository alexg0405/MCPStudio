/** What the automation menus and dialogs do (shared by the playlist and the feature's registrations). */
import type { Services } from '@app/services';
import { LFO_SHAPES, lfoPoints, type LfoShape } from '@core/automation/generate';
import { formatBST, ticksPerBar, ticksPerBeat, TICKS_PER_STEP } from '@core/time/ppq';
import {
  AUTO_SHAPES,
  type AutomationChannel,
  type AutomationClip,
  type AutoShape,
  type ParamTarget,
} from '@core/model/types';
import {
  removeAutomation,
  removeAutomationPoint,
  setAutomationPoints,
  setAutomationPointShape,
  setAutomationPointTension,
} from '@core/ops/automation';
import { p } from '@agstudio/sdk';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';
import { openWindow } from '../../workspace/registry';

export const SHAPE_LABELS: Record<AutoShape, string> = {
  curve: 'Curve (drag its handle to bend it)',
  hold: 'Hold (jumps at the next point)',
  stairs: 'Stairs (4 steps to the next point)',
  smooth: 'Smooth (S-shaped)',
};

const SHAPE_NAMES: Record<AutoShape, string> = { curve: 'Curve', hold: 'Hold', stairs: 'Stairs', smooth: 'Smooth' };

export function automationChannelOf(s: Services, clip: AutomationClip): AutomationChannel | null {
  const ch = s.doc.getState().project.channels[clip.channelId];
  return ch?.kind === 'automation' ? ch : null;
}

/** "Create automation clip": makes it, shows it in the playlist, and says how to hear it. */
export function createAutomationFor(s: Services, target: ParamTarget): void {
  const made = s.automation.createClip(target);
  if (!made) return;
  openWindow(s, 'playlist');
  const name = s.automation.nameOf(target) ?? 'Automation';
  s.session
    .getState()
    .toast(
      s.view.getState().mode === 'song'
        ? `Created automation clip ‘${name}’: double-click it to add points`
        : `Created automation clip ‘${name}’: it plays in Song mode (press L to switch)`,
    );
}

/** Right-click on an automation point: its shape, straightening, deleting. */
export function pointMenu(s: Services, clip: AutomationClip, index: number): MenuEntry[] {
  const ch = automationChannelOf(s, clip);
  const point = ch?.points[index];
  if (!ch || !point) return [];
  const id = ch.id;
  const shape = point.shape ?? 'curve';
  const at = formatBST(clip.start - clip.offset + point.tick, s.doc.getState().project.transport.timeSig);
  const value = ch.target ? s.automation.format(ch.target, point.value, ch.range) : `${Math.round(point.value * 100)}%`;
  return [
    { kind: 'label', label: `Point at ${at} · ${value}` },
    {
      kind: 'submenu',
      label: 'Point shape',
      items: AUTO_SHAPES.map((sh) => ({
        label: SHAPE_LABELS[sh],
        checked: sh === shape,
        onSelect: () =>
          s.history.transact(`Point shape: ${SHAPE_NAMES[sh]}`, (d) => setAutomationPointShape(d, id, index, sh)),
      })),
    },
    {
      label: 'Straighten curve',
      disabled: !point.tension,
      onSelect: () => s.history.transact('Straighten curve', (d) => setAutomationPointTension(d, id, index, 0)),
    },
    { kind: 'separator' },
    {
      label: 'Delete point',
      danger: true,
      disabled: ch.points.length <= 1,
      onSelect: () => s.history.transact('Delete automation point', (d) => removeAutomationPoint(d, id, index)),
    },
  ];
}

/** Opens the window of what a target controls (its plugin, the channel rack or the mixer). */
export function showTarget(s: Services, target: ParamTarget): void {
  switch (target.kind) {
    case 'channel':
      s.session.getState().selectChannel(target.channelId);
      openWindow(s, 'channel-rack');
      return;
    case 'plugin':
      if (target.owner.kind === 'channel') openWindow(s, 'plugin', { kind: 'channel', channelId: target.owner.channelId });
      else openWindow(s, 'plugin', { kind: 'fx', insertId: target.owner.insertId, slotId: target.owner.slotId });
      return;
    case 'insert':
    case 'slot':
    case 'route':
      s.session.getState().selectInsert(target.insertId);
      openWindow(s, 'mixer');
      return;
    case 'tempo':
      return;
  }
}

/** The automation part of an automation clip's ▾ menu. */
export function automationClipMenu(s: Services, clip: AutomationClip): MenuEntry[] {
  const ch = automationChannelOf(s, clip);
  if (!ch) return [];
  const id = ch.id;
  const target = ch.target;
  const exists = !!target && s.automation.nameOf(target) !== null;
  const clips = Object.values(s.doc.getState().project.playlist.clips).filter(
    (c) => c.kind === 'automation' && c.channelId === id,
  ).length;
  return [
    { label: 'Generate LFO…', onSelect: () => void generateLfo(s, clip) },
    {
      kind: 'submenu',
      label: 'Shape of every point',
      items: AUTO_SHAPES.map((sh) => ({
        label: SHAPE_LABELS[sh],
        onSelect: () =>
          s.history.transact(`Every point: ${SHAPE_NAMES[sh]}`, (d) => {
            const c = d.channels[id];
            if (c?.kind === 'automation') c.points.forEach((_, i) => setAutomationPointShape(d, id, i, sh));
          }),
      })),
    },
    {
      label: 'Show what this controls',
      disabled: !exists || target?.kind === 'tempo',
      onSelect: () => target && showTarget(s, target),
    },
    {
      label: clips > 1 ? `Delete this automation (all ${clips} clips)` : 'Delete this automation',
      danger: true,
      onSelect: () => s.history.transact('Delete automation', (d) => removeAutomation(d, id)),
    },
  ];
}

/** LFO speeds: one cycle every so many steps, beats or bars. */
const SPEEDS: readonly { value: string; label: string; ticks(beat: number, bar: number): number }[] = [
  { value: 'step', label: '1 step (1/16)', ticks: () => TICKS_PER_STEP },
  { value: '2steps', label: '2 steps (1/8)', ticks: () => 2 * TICKS_PER_STEP },
  { value: 'beat', label: '1 beat', ticks: (beat) => beat },
  { value: '2beats', label: '2 beats', ticks: (beat) => 2 * beat },
  { value: 'bar', label: '1 bar', ticks: (_, bar) => bar },
  { value: '2bars', label: '2 bars', ticks: (_, bar) => 2 * bar },
  { value: '4bars', label: '4 bars', ticks: (_, bar) => 4 * bar },
];

const SHAPES: Record<LfoShape, string> = {
  sine: 'Sine (smooth wave)',
  triangle: 'Triangle',
  saw: 'Saw (ramp up, drop)',
  square: 'Square (on / off)',
  random: 'Random steps',
};

/**
 * "Generate LFO…": fills the clip with a repeating wave. Every change in the dialog previews (and
 * plays) right away; OK keeps it as one undo step, Cancel puts the old curve back.
 */
export async function generateLfo(s: Services, clip: AutomationClip): Promise<void> {
  const ch = automationChannelOf(s, clip);
  if (!ch) return;
  const ts = s.doc.getState().project.transport.timeSig;
  const beat = ticksPerBeat(ts);
  const bar = ticksPerBar(ts);
  const period = (speed: string) => (SPEEDS.find((o) => o.value === speed) ?? SPEEDS[2])!.ticks(beat, bar);
  const values = { shape: 'sine', speed: 'beat', depth: 0.8, center: 0.5, phase: 0 };
  const gesture = s.history.gesture('Generate LFO');
  const id = ch.id;
  const apply = (v: typeof values) =>
    gesture.update((d) =>
      setAutomationPoints(
        d,
        id,
        lfoPoints(clip.offset, clip.length, {
          shape: (LFO_SHAPES as readonly string[]).includes(v.shape) ? (v.shape as LfoShape) : 'sine',
          period: period(String(v.speed)),
          depth: Number(v.depth),
          center: Number(v.center),
          phase: Number(v.phase),
          seed: 1 + Math.round(Number(v.phase) * 1000),
        }),
      ),
    );
  apply(values);
  const result = await showFormDialog({
    title: 'Generate LFO',
    message: 'Fills this clip with a repeating wave (its points are replaced). You hear changes right away.',
    fields: [
      { kind: 'choice', key: 'shape', label: 'Shape', options: LFO_SHAPES.map((v) => ({ value: v, label: SHAPES[v] })) },
      { kind: 'choice', key: 'speed', label: 'One cycle every', options: SPEEDS.map((o) => ({ value: o.value, label: o.label })) },
      { kind: 'param', key: 'depth', spec: p.float(0, 1, 0.8, { label: 'Depth', unit: '%', hint: 'How far the wave swings' }) },
      { kind: 'param', key: 'center', spec: p.float(0, 1, 0.5, { label: 'Center', unit: '%', hint: 'The middle of the swing' }) },
      { kind: 'param', key: 'phase', spec: p.float(0, 1, 0, { label: 'Start', unit: '%', hint: 'Where in its cycle the wave starts' }) },
    ],
    values,
    onChange: (v) => apply(v as typeof values),
    okLabel: 'Apply',
  });
  if (result) gesture.commit();
  else gesture.cancel();
}
