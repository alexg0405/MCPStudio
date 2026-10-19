import type { Services } from '@app/services';
import { addChannelMenu, ChannelRack } from './ChannelRack';
import { deleteChannel } from '@app/actions/channels';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { addMenuItems, cmd, sep, submenu } from '../../shell/menus';
import { showContextMenu } from '../../controls/ContextMenu';
import { addContextMenuItems } from '../../context-menus';
import { stepsMenu, stepTarget, stepTools, toggleGraph } from './steps';

/** The channel rack's step tools as commands: id, title, hint and what each does to the selected channel's steps. */
const STEP_COMMANDS: readonly [string, string, string, (s: Services) => void][] = [
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

/** The selected channel is one a step tool can work on. */
const canStep = (s: Services) => !!stepTarget(s);

/** The channel selected in the rack, if any. */
const selected = (s: Services) => s.session.getState().selectedChannelId;

/** The channel rack: its window, channel commands, step tools, keys and menus. */
export function register(services: Services): void {
  registerRackWindow(services);
  registerChannelCommands(services);
  registerStepCommands(services);
  registerRackMenus();
}

/** The window type and the command that shows or hides it. */
function registerRackWindow(services: Services): void {
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
}

/** Add, delete and move the selection between channels, with their keys. */
function registerChannelCommands({ commands, keymap }: Services): void {
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
  /** A command run that moves the channel selection by `delta` rows, stopping at the ends. */
  const selectChannelBy = (delta: number) => (s: Services) => {
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
    run: selectChannelBy(-1),
  });
  commands.register({
    id: 'channels.selectNext',
    title: 'Select next channel',
    category: 'Channels',
    hint: 'Select the channel below the selected one',
    run: selectChannelBy(1),
  });

  keymap.add([
    { chord: 'Alt+Delete', command: 'channels.delete', when: { focus: ['channel-rack'] } },
    { chord: 'Alt+Backspace', command: 'channels.delete', when: { focus: ['channel-rack'] } },
    { chord: 'ArrowUp', command: 'channels.selectPrev', when: { focus: ['channel-rack'] }, repeat: true },
    { chord: 'ArrowDown', command: 'channels.selectNext', when: { focus: ['channel-rack'] }, repeat: true },
  ]);
  addMenuItems('add', [cmd('channels.add', 10)]);
}

/** The step tools (fill, rotate, shift, reverse, randomize, clear) and the graph editor, with their keys. */
function registerStepCommands({ commands, keymap }: Services): void {
  for (const [id, title, hint, run] of STEP_COMMANDS)
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
}

/** The channel's right-click Steps submenu and the Patterns menu's Steps entries. */
function registerRackMenus(): void {
  // The channel's right-click menu gets the same Steps submenu and the graph editor toggle.
  addContextMenuItems('rack.channel', ({ channelId }, s) =>
    stepTarget(s, channelId) ? [{ kind: 'submenu', label: 'Steps', items: () => stepsMenu(s, channelId) }] : [],
  );
  // And the menu bar: Patterns > Steps of the selected channel.
  addMenuItems('patterns', [
    sep(200),
    submenu('rack.steps', 'Steps of the selected channel', 210, () => [
      ...STEP_COMMANDS.slice(0, 3).map(([id], i) => cmd(id, i)),
      sep(10),
      ...STEP_COMMANDS.slice(3, 8).map(([id], i) => cmd(id, 11 + i)),
      sep(20),
      ...STEP_COMMANDS.slice(8).map(([id], i) => cmd(id, 21 + i)),
      sep(30),
      cmd('rack.graphEditor', 31),
    ]),
  ]);
}
