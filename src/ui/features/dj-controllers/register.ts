import type { Services } from '@app/services';
import { djControllers, restoreControllers } from '@app/dj/controllers';
import { isTargetId } from '@core/midi-map/targets';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd } from '../../shell/menus';
import { lazyWindow } from '../../workspace/lazy';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { installLearnModeListeners } from './learn-listeners';

/** The Controllers window opens this big (px) when the workspace has room, with this gap above it. */
const WINDOW_WIDTH_PX = 800;
const WINDOW_HEIGHT_PX = 620;
const WINDOW_TOP_PX = 50;

/** What `dj.controllers.learn` accepts. */
export interface LearnArgs {
  target?: string;
  shifted?: boolean;
}

/**
 * DJ controllers: the Controllers window, MIDI learn for the decks' controls, presets, LEDs.
 *
 * Any element with a `data-dj-target="A.play"` attribute (the Decks window's controls) joins in: in learn
 * mode a click on it picks it as the control to link, and its right-click menu offers "Link to controller…".
 */
export function register(services: Services): void {
  const { commands } = services;
  registerWindowType({
    type: 'dj-controllers',
    title: () => 'DJ controllers',
    component: lazyWindow(() => import('./ControllersWindow'), (m) => m.ControllersWindow),
    defaultRect: (ws) => ({
      x: Math.max(0, Math.round(ws.w / 2 - WINDOW_WIDTH_PX / 2)),
      y: WINDOW_TOP_PX,
      w: Math.min(WINDOW_WIDTH_PX, ws.w),
      h: Math.min(WINDOW_HEIGHT_PX, ws.h - WINDOW_TOP_PX - 20),
    }),
    minSize: { w: 520, h: 320 },
  });
  registerWindowToggle(services, {
    command: 'dj.controllers.open',
    type: 'dj-controllers',
    title: 'DJ controllers',
    hint: 'Connect a DJ controller: it drives the decks, its lights follow them, and you can link any control with MIDI learn',
    chords: [],
    menuOrder: 58,
  });
  commands.register({
    id: 'dj.controllers.connect',
    title: 'Connect DJ controllers…',
    category: 'DJ',
    hint: 'Ask the browser for MIDI access and start listening to your DJ controller (the browser shows a permission prompt the first time)',
    gesture: true,
    run: async (s) => {
      openWindow(s, 'dj-controllers');
      await djControllers(s).enable();
    },
  });
  commands.register<LearnArgs | undefined>({
    id: 'dj.controllers.learn',
    title: 'Link a DJ controller (MIDI learn)…',
    category: 'DJ',
    hint: 'Open the Controllers window and link a control: pick what it should do, then move or press it on your controller',
    argsHint:
      "optional { target: 'A.play' | 'B.cue' | 'A.hotcue:3' | 'A.eq.low' | 'A.pitch' | 'A.jog' | 'crossfader' | 'browse' | 'A.load' | 'shift'…, shifted: boolean }. The musician has to touch the control on the controller themselves: this only opens the window and waits",
    run: (s, args) => {
      openWindow(s, 'dj-controllers');
      const dj = djControllers(s);
      if (args?.target && isTargetId(args.target)) dj.learnTarget(args.target, args.shifted === true);
      else if (args?.target === 'shift') dj.learnTarget('shift');
      else dj.startLearn();
    },
  });
  commands.register({
    id: 'dj.controllers.stopLearn',
    title: 'Stop linking controls',
    category: 'DJ',
    hint: 'Leave MIDI learn',
    enabled: (s) => djControllers(s).store.getState().learn !== null,
    run: (s) => djControllers(s).cancelLearn(),
  });
  addMenuItems('view', [cmd('dj.controllers.learn', 59)]);
  addActionProvider('dj-controllers', (s) => [
    {
      key: 'dj.controllers.learn',
      label: 'Link my DJ controller (MIDI learn)',
      path: ['View', 'DJ controllers'],
      hint: 'Connect a DJ controller and link its faders, knobs, jog wheels and buttons to the decks',
      keywords: ['midi', 'learn', 'controller', 'ddj', 'hercules', 'numark', 'pioneer', 'jog', 'dj', 'decks', 'map'],
      run: () => void s.commands.run('dj.controllers.learn'),
    },
  ]);
  setWindowHelp('dj-controllers', {
    intro: 'Play the decks with your DJ controller. Popular controllers have a ready-made map; for any other, link each control yourself (MIDI learn).',
    moves: [
      ['Connect controllers', 'Allow MIDI in the browser’s prompt; your controller then shows up here by itself'],
      ['Learn controls', 'Click a control in the list (or on a deck), then move or press it on your controller: its type is detected'],
      ['Learn / + Shift / Clear', 'Link one control, link what it does while Shift is held, or remove its links'],
      ['A link (the grey pill)', 'Click it to reverse a fader, change a jog wheel’s speed, or remove it'],
      ['Clip launcher section', 'Pad controllers (Launchpad and similar): their pads launch the clip launcher’s slots and light up with the slot’s state; click a slot in the clip launcher while learning to link it'],
      ['Test tab', 'Every message your controller sends, and what it did: the quickest way to check a controller'],
      ['Ready-made map…', 'Pick a map for your controller if it was not recognised by its name; Export and Import share your own'],
    ],
  });

  installLearnModeListeners(services);
  // Come back on after a reload when the browser already allows MIDI.
  void restoreControllers(services);
}
