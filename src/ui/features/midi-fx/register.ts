import type { Services } from '@app/services';
import {
  addMidiEffect,
  bakeMidiEffects,
  clearMidiEffects,
  findMidiFxChain,
  loadMidiFxChain,
  MIDI_EFFECT_CHOICES,
  toggleAllMidiEffects,
} from '@app/actions/midi-fx';
import { midiFxDef } from '@core/midi-fx/registry';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd, sep, submenu, type MenuItem } from '../../shell/menus';
import { addContextMenuItems } from '../../context-menus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';
import { report } from './menus';

const selected = (s: Services) => s.session.getState().selectedChannelId;

/** The selected channel as the document has it (undefined when none is selected). */
const selectedChannel = (s: Services) => {
  const id = selected(s);
  return id ? s.doc.getState().project.channels[id] : undefined;
};

/** The selected channel when it plays notes (only an instrument channel has MIDI effects). */
function instrumentChannel(s: Services) {
  const id = selected(s);
  return id && s.doc.getState().project.channels[id]?.kind === 'instrument' ? id : null;
}

/** An effect id typed by a person or Studio: its id ("arp") or its name ("Arpeggiator"), however it is capitalized. */
function effectIdOf(text: string): string | null {
  const wanted = text.trim().toLowerCase();
  const found = MIDI_EFFECT_CHOICES.find((choice) => choice.id === wanted || choice.name.toLowerCase() === wanted);
  return found?.id ?? null;
}

/**
 * MIDI effects: a chain per instrument channel that changes the notes on their way to the instrument, for keys you play and
 * for the song (arpeggiator, chords, scale, note repeat, echo, humanize, velocity, transpose, note length, random). Studio has
 * the same through the `midi_effect` and `render_midi_effects` actions and the `get_midi_effects` read.
 */
export function register(services: Services): void {
  registerFxWindow(services);
  registerFxCommands(services);
  registerFxMenus(services);
  registerFxHelp();
}

/** The MIDI effects window and the command that shows or hides it. */
function registerFxWindow(services: Services): void {
  registerWindowType({
    type: 'midi-fx',
    title: (_props, s) => {
      const id = instrumentChannel(s);
      const name = id ? s.doc.getState().project.channels[id]?.name : undefined;
      return name ? `MIDI effects — ${name}` : 'MIDI effects';
    },
    component: lazyWindow(() => import('./MidiFxWindow'), (m) => m.MidiFxWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 330)), y: 60, w: Math.min(660, ws.w), h: Math.min(520, ws.h - 80) }),
    minSize: { w: 420, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.midiFx',
    type: 'midi-fx',
    title: 'MIDI effects',
    hint: 'The selected channel’s MIDI effects: an arpeggiator, chords, scale, echo and more, between your keys (and the song’s notes) and the instrument',
    chords: ['Alt+E'],
    menuOrder: 64,
  });
}

/** Add, render, bypass, remove and load a chain, for the selected channel. */
function registerFxCommands({ commands }: Services): void {
  commands.register<string | { effect: string; channel?: string }>({
    id: 'midiFx.add',
    title: 'Add a MIDI effect…',
    category: 'MIDI effects',
    hint: 'Put an effect (arpeggiator, chord, scale, note repeat, echo, humanize, velocity, transpose, note length, random) on the selected channel',
    argsHint: `an effect id (${MIDI_EFFECT_CHOICES.map((choice) => choice.id).join(', ')}) or { effect, channel }; the selected channel unless a channel id is given. Without one it opens the MIDI effects window`,
    enabled: (s) => !!instrumentChannel(s),
    run: (s, args) => {
      const channelId = (typeof args === 'object' ? args.channel : undefined) ?? instrumentChannel(s);
      const effect = effectIdOf(typeof args === 'string' ? args : (args?.effect ?? ''));
      if (!channelId || !effect) {
        openWindow(s, 'midi-fx');
        return;
      }
      addMidiEffect(s, channelId as never, effect);
    },
  });
  commands.register({
    id: 'midiFx.bake',
    title: 'Render MIDI effects to notes',
    category: 'MIDI effects',
    hint: 'Write what the selected channel’s MIDI effects make into its patterns as notes, and take the effects out of the way (one undo step)',
    enabled: (s) => hasActiveMidiFx(selectedChannel(s)),
    run: (s) => {
      const id = instrumentChannel(s);
      if (id) report(s, bakeMidiEffects(s, id));
    },
  });
  commands.register({
    id: 'midiFx.bypass',
    title: 'Bypass or turn on all MIDI effects',
    category: 'MIDI effects',
    hint: 'Switch the selected channel’s whole MIDI effects chain off, or on again, to hear it with and without',
    enabled: (s) => midiFxOf(selectedChannel(s)).length > 0,
    run: (s) => {
      const id = instrumentChannel(s);
      if (id) toggleAllMidiEffects(s, id);
    },
  });
  commands.register({
    id: 'midiFx.clear',
    title: 'Remove all MIDI effects',
    category: 'MIDI effects',
    hint: 'Take every MIDI effect off the selected channel (one undo step)',
    enabled: (s) => midiFxOf(selectedChannel(s)).length > 0,
    run: (s) => {
      const id = instrumentChannel(s);
      if (id) clearMidiEffects(s, id);
    },
  });
  commands.register<string>({
    id: 'midiFx.chain',
    title: 'Load a MIDI effects chain…',
    category: 'MIDI effects',
    hint: 'Put a ready-made or saved chain of MIDI effects on the selected channel, replacing its effects',
    argsHint: 'the name of a chain: one of yours, or a ready-made one such as "Pluck arp", "Trance gate", "Dub echo"; without a name it opens the MIDI effects window',
    enabled: (s) => !!instrumentChannel(s),
    run: (s, name) => {
      const id = instrumentChannel(s);
      const chain = id && name ? findMidiFxChain(s, name) : null;
      if (!id || !chain) {
        if (name) s.session.getState().toast(`There is no MIDI effects chain called “${name}”.`, 'error');
        else openWindow(s, 'midi-fx');
        return;
      }
      report(s, loadMidiFxChain(s, id, chain.name, chain.slots));
    },
  });
}

/** The "MIDI effects" submenu of the Patterns menu and of a channel's right-click menu, and the action search. */
function registerFxMenus(_services: Services): void {
  const addEntries = (): MenuItem[] =>
    MIDI_EFFECT_CHOICES.map((choice, i) => ({ kind: 'command', command: 'midiFx.add', args: choice.id, label: choice.name, order: i }));
  addMenuItems('patterns', [
    sep(220),
    submenu('midi-fx', 'MIDI effects of the selected channel', 230, () => [
      cmd('view.midiFx', 1, 'Show the MIDI effects window'),
      sep(2),
      submenu('midi-fx.add', 'Add an effect', 3, addEntries),
      cmd('midiFx.chain', 4),
      cmd('midiFx.bypass', 5),
      sep(6),
      cmd('midiFx.bake', 7),
      cmd('midiFx.clear', 8),
    ]),
  ]);
  addContextMenuItems('rack.channel', ({ channelId }, s): MenuEntry[] => {
    if (s.doc.getState().project.channels[channelId]?.kind !== 'instrument') return [];
    const chain = midiFxOf(s.doc.getState().project.channels[channelId]);
    return [
      {
        kind: 'submenu',
        label: chain.length > 0 ? `MIDI effects (${chain.length})` : 'MIDI effects',
        items: () => [
          { label: 'Open the MIDI effects window', onSelect: () => openWindow(s, 'midi-fx') },
          { kind: 'separator' },
          ...MIDI_EFFECT_CHOICES.map(
            (choice): MenuEntry => ({ label: `Add ${choice.name}`, hint: choice.description, onSelect: () => void addMidiEffect(s, channelId, choice.id) }),
          ),
          { kind: 'separator' },
          { label: 'Render to notes', disabled: !hasActiveMidiFx(s.doc.getState().project.channels[channelId]), onSelect: () => report(s, bakeMidiEffects(s, channelId)) },
          { label: 'Remove all effects', danger: true, disabled: chain.length === 0, onSelect: () => clearMidiEffects(s, channelId) },
        ],
      },
    ];
  });
  addActionProvider('midi-fx', (s) => [
    {
      key: 'midi-fx.open',
      label: 'MIDI effects: arpeggiator, chords, scale, echo…',
      path: ['View', 'MIDI effects'],
      hint: 'Effects that change the notes on their way to the instrument, for the keys you play and for the song',
      keywords: ['midi', 'arp', 'arpeggiator', 'arpeggio', 'chord', 'scale', 'echo', 'humanize', 'transpose', 'latch', 'note repeat', 'roll', 'effects'],
      run: () => openWindow(s, 'midi-fx'),
    },
    ...MIDI_EFFECT_CHOICES.map((choice) => ({
      key: `midi-fx.add.${choice.id}`,
      label: `Add ${choice.name} (MIDI effect)`,
      path: ['Patterns', 'MIDI effects of the selected channel', 'Add an effect'],
      hint: midiFxDef(choice.id)?.description ?? choice.description,
      keywords: ['midi effect', choice.id, choice.name.toLowerCase()],
      run: () => void s.commands.run('midiFx.add', choice.id),
    })),
  ]);
}

/** What the window's help panel says. */
function registerFxHelp(): void {
  setWindowHelp('midi-fx', {
    intro:
      'Effects that change notes on their way to the instrument, for the keys you play and for the song. Select an instrument channel in the channel rack to see its effects.',
    moves: [
      ['Add effect', 'Arpeggiator, Chord, Scale, Note repeat, MIDI echo, Humanize, Velocity, Transpose, Note length or Random, in the order the notes go through them'],
      ['The LED', 'Bypasses one effect: the notes pass through it unchanged (right-click for more)'],
      ['Drag the title bar of an effect', 'Changes the order (Alt+Up and Alt+Down do it from the keyboard)'],
      ['Presets ▾', 'Ready-made settings for the effect, your own, or back to the defaults'],
      ['Chains ▾', 'Ready-made chains, your saved chains, saving this one, and removing all effects'],
      ['Render to notes', 'Writes what the effects make into the patterns as ordinary notes and takes the effects out of the way (one undo step)'],
      ['Right-click a knob', 'Create an automation clip or link it to a MIDI controller, like any knob'],
    ],
  });
}
