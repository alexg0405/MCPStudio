import type { Services } from '@app/services';
import { addChannelMenu, ChannelRack } from './ChannelRack';
import { deleteChannel } from '@app/actions/channels';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { addMenuItems, cmd, sep, submenu } from '../../shell/menus';
import { showContextMenu } from '../../controls/ContextMenu';
import { addContextMenuItems } from '../../context-menus';
import { stepsMenu, stepTarget, stepTools, toggleGraph } from './steps';

export function register(services: Services): void {
  registerWindowType({
    type: 'channel-rack',
    title: () => 'Channel rack',
    component: ChannelRack,
    defaultRect: (ws) => ({ x: 48, y: 36, w: Math.min(640, ws.w - 96), h: 300 }),
    minSize: { w: 420, h: 160 },
  });
  registerWindowToggle(services, {
    command: 'view.channelRack',
    type: 'channel-rack',
    title: 'Channel rack',
    hint: 'Show or hide the channel rack',
    chords: ['F6', 'Alt+2'],
    menuOrder: 20,
  });

  const { commands, keymap } = services;
  const selected = (s: Services) => s.session.getState().selectedChannelId;

  commands.register({
    id: 'channels.add',
    title: 'Channel…',
    category: 'Channels',
    hint: 'Add a kit sound or instrument channel',
    // A menu; the add_channel action adds any instrument.
    ai: false,
    run: (s) => showContextMenu({ x: window.innerWidth / 3, y: 80 }, addChannelMenu(s)),
  });
  commands.register({
    id: 'channels.delete',
    title: 'Delete selected channel',
    category: 'Channels',
    hint: 'Delete the selected channel and its notes',
    enabled: (s) => !!selected(s),
    run: (s) => {
      const id = selected(s);
      if (id) deleteChannel(s, id);
    },
  });
  const step = (delta: number) => (s: Services) => {
    const order = s.doc.getState().project.channelOrder;
    const i = order.indexOf(selected(s) ?? order[0]!);
    const next = order[Math.max(0, Math.min(order.length - 1, i + delta))];
    if (next) s.session.getState().selectChannel(next);
  };
  commands.register({
    id: 'channels.selectPrev',
    title: 'Select previous channel',
    category: 'Channels',
    hint: 'Select the channel above the selected one',
    run: step(-1),
  });
  commands.register({
    id: 'channels.selectNext',
    title: 'Select next channel',
    category: 'Channels',
    hint: 'Select the channel below the selected one',
    run: step(1),
  });

  keymap.add([
    { chord: 'Alt+Delete', command: 'channels.delete', when: { focus: ['channel-rack'] } },
    { chord: 'Alt+Backspace', command: 'channels.delete', when: { focus: ['channel-rack'] } },
    { chord: 'ArrowUp', command: 'channels.selectPrev', when: { focus: ['channel-rack'] }, repeat: true },
    { chord: 'ArrowDown', command: 'channels.selectNext', when: { focus: ['channel-rack'] }, repeat: true },
  ]);
  addMenuItems('add', [cmd('channels.add', 10)]);

  // ---- M11 step tools (on the selected channel; also in the rack's "Steps ▾" menu) ----
  const canStep = (s: Services) => !!stepTarget(s);
  const stepCommands: [string, string, string, (s: Services) => void][] = [
    [
      'rack.fill2',
      'Fill every 2 steps',
      'Turn on every 2nd step (replaces the channel’s steps)',
      (s) => stepTools.fill(s, null, 2),
    ],
    [
      'rack.fill4',
      'Fill every 4 steps',
      'Turn on every 4th step (replaces the channel’s steps)',
      (s) => stepTools.fill(s, null, 4),
    ],
    [
      'rack.fill8',
      'Fill every 8 steps',
      'Turn on every 8th step (replaces the channel’s steps)',
      (s) => stepTools.fill(s, null, 8),
    ],
    [
      'rack.rotateLeft',
      'Rotate steps left',
      'Move every step one to the left; the first wraps to the end',
      (s) => stepTools.rotate(s, null, -1),
    ],
    [
      'rack.rotateRight',
      'Rotate steps right',
      'Move every step one to the right; the last wraps to the start',
      (s) => stepTools.rotate(s, null, 1),
    ],
    [
      'rack.shiftLeft',
      'Shift steps left',
      'Move every step one to the left; the first one is dropped',
      (s) => stepTools.shift(s, null, -1),
    ],
    [
      'rack.shiftRight',
      'Shift steps right',
      'Move every step one to the right; the last one is dropped',
      (s) => stepTools.shift(s, null, 1),
    ],
    ['rack.reverse', 'Reverse steps', 'Play the channel’s steps backwards', (s) => stepTools.reverse(s, null)],
    [
      'rack.randomize',
      'Randomize steps',
      'Replace the channel’s steps with a random pattern',
      (s) => stepTools.randomize(s, null),
    ],
    ['rack.clear', 'Clear steps', 'Remove all of the channel’s notes in this pattern', (s) => stepTools.clear(s, null)],
  ];
  for (const [id, title, hint, run] of stepCommands)
    commands.register({ id, title, category: 'Channels', hint, enabled: canStep, run });
  commands.register({
    id: 'rack.graphEditor',
    title: 'Graph editor',
    category: 'Channels',
    hint: 'Edit each step’s velocity, pan, release, pitch or fine pitch in a row under the channel',
    enabled: canStep,
    checked: (s) => {
      const id = s.session.getState().selectedChannelId;
      return !!id && s.editor.getState().stepGraph.channelId === id;
    },
    run: (s) => {
      const id = s.session.getState().selectedChannelId;
      if (id && stepTarget(s, id)) toggleGraph(s, id);
    },
  });
  keymap.add([
    { chord: 'Mod+Shift+ArrowLeft', command: 'rack.rotateLeft', when: { focus: ['channel-rack'] }, repeat: true },
    { chord: 'Mod+Shift+ArrowRight', command: 'rack.rotateRight', when: { focus: ['channel-rack'] }, repeat: true },
  ]);
  // The channel's right-click menu gets the same Steps submenu and the graph editor toggle.
  addContextMenuItems('rack.channel', ({ channelId }, s) =>
    stepTarget(s, channelId) ? [{ kind: 'submenu', label: 'Steps', items: () => stepsMenu(s, channelId) }] : [],
  );
  // And the menu bar: Patterns > Steps of the selected channel.
  addMenuItems('patterns', [
    sep(200),
    submenu('rack.steps', 'Steps of the selected channel', 210, () => [
      ...stepCommands.slice(0, 3).map(([id], i) => cmd(id, i)),
      sep(10),
      ...stepCommands.slice(3, 8).map(([id], i) => cmd(id, 11 + i)),
      sep(20),
      ...stepCommands.slice(8).map(([id], i) => cmd(id, 21 + i)),
      sep(30),
      cmd('rack.graphEditor', 31),
    ]),
  ]);
}
