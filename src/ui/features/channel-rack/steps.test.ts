import { describe, expect, it } from 'vitest';
import { seeded } from '@agstudio/sdk/notes';
import { createTestServices } from '@app/testing';
import type { ChannelId, NoteId, PatternId } from '@core/model/types';
import { setStep } from '@core/ops/notes';
import { stepView } from '@core/query/queries';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { stepAtX, stepX } from './layout';
import { register } from './register';
import { formatStepValue, stepEdit, stepsMenu, stepTools, stepValue, toggleGraph } from './steps';

function setup() {
  const s = createTestServices();
  register(s);
  const p = s.doc.getState().project;
  const kick = p.channelOrder[0] as ChannelId;
  const pid = p.patternOrder[0] as PatternId;
  s.session.getState().selectChannel(kick);
  s.history.transact('seed', (d) => {
    for (const i of [0, 1, 6]) setStep(d, pid, kick, i, true, { rootKey: 60 });
  });
  const row = () => {
    const pattern = s.doc.getState().project.patterns[pid]!;
    return stepView(pattern.notes[kick], pattern.stepCount)
      .velocities.map((v) => (v > 0 ? 1 : 0))
      .join('');
  };
  return { s, kick, pid, row };
}

const click = (items: MenuEntry[], label: string) => {
  const entry = items.find((i) => 'label' in i && i.label === label);
  if (!entry || entry.kind !== undefined) throw new Error(`no item ${label}`);
  entry.onSelect();
};

describe('step tools', () => {
  it('are in a visible menu with plain names, each one undo step', () => {
    const { s, kick, row } = setup();
    const menu = stepsMenu(s, kick);
    expect(menu[0]).toEqual({ kind: 'label', label: 'Steps of Kick' });
    click(menu, 'Fill every 4 steps');
    expect(row()).toBe('1000100010001000');
    expect(s.history.status().undoLabel).toBe('Fill every 4 steps (Kick)');
    click(stepsMenu(s, kick), 'Rotate right (wraps around)');
    expect(row()).toBe('0100010001000100');
    click(stepsMenu(s, kick), 'Shift left (drops the first step)');
    expect(row()).toBe('1000100010001000');
    click(stepsMenu(s, kick), 'Reverse');
    expect(row()).toBe('0001000100010001');
    click(stepsMenu(s, kick), 'Clear');
    expect(row()).toBe('0000000000000000');
    s.history.undo();
    expect(row()).toBe('0001000100010001');
  });

  it('run from commands and shortcuts on the selected channel', () => {
    const { s, row } = setup();
    expect(s.commands.run('rack.fill2')).toBe(true);
    expect(row()).toBe('1010101010101010');
    expect(s.commands.run('rack.rotateLeft')).toBe(true);
    expect(row()).toBe('0101010101010101');
    expect(s.keymap.chordsFor('rack.rotateRight')).toEqual(['Shift+Meta+ArrowRight']);
    s.session.getState().selectChannel(null);
    expect(s.commands.isEnabled('rack.reverse')).toBe(false);
    expect(stepsMenu(s, null)).toEqual([{ kind: 'label', label: 'Select an instrument channel first' }]);
  });

  it('randomize from a seeded source', () => {
    const { s, kick, row } = setup();
    stepTools.randomize(s, kick, seeded(3));
    const once = row();
    s.history.undo();
    stepTools.randomize(s, kick, seeded(3));
    expect(row()).toBe(once);
    expect(once).toMatch(/1/);
  });

  it('the channel menu has the Steps submenu and the graph editor toggle', () => {
    const { s, kick } = setup();
    const extra = extraMenuItems('rack.channel', { channelId: kick }, s);
    const steps = extra.find((e) => e.kind === 'submenu' && e.label === 'Steps');
    expect(steps).toBeTruthy();
    toggleGraph(s, kick);
    expect(s.editor.getState().stepGraph.channelId).toBe(kick);
    const graph = stepsMenu(s, kick).find((e) => 'label' in e && e.label.startsWith('Graph editor'));
    expect(graph && 'checked' in graph && graph.checked).toBe(true);
    expect(s.commands.isChecked('rack.graphEditor')).toBe(true);
    s.commands.run('rack.graphEditor');
    expect(s.editor.getState().stepGraph.channelId).toBeNull();
  });
});

describe('graph editor lanes', () => {
  const n = { id: 'x' as NoteId, tick: 0, length: 240, key: 63, velocity: 0.5, pan: -0.25, fine: 40 };

  it('map step values both ways', () => {
    expect(stepValue(n, 'key', 60)).toBe(3 / 24);
    expect(stepEdit(n.id, 'key', 3 / 24, 60)).toEqual({ id: 'x', key: 63 });
    expect(stepEdit(n.id, 'key', -2, 60)).toEqual({ id: 'x', key: 36 });
    expect(formatStepValue('key', 3 / 24, 60)).toBe('D#5 (+3 st)');
    expect(stepValue(n, 'pan', 60)).toBe(-0.25);
    expect(formatStepValue('pan', -0.25, 60)).toBe('25% left');
    expect(formatStepValue('fine', 0.4, 60)).toBe('+40 ct');
    expect(formatStepValue('velocity', 0.5, 60)).toBe('50%');
  });

  it('find the step under the pointer', () => {
    expect(stepAtX(stepX(5) + 3, 16)).toBe(5);
    expect(stepAtX(-10, 16)).toBe(-1);
    expect(stepAtX(stepX(15) + 40, 16)).toBe(-1);
  });
});
