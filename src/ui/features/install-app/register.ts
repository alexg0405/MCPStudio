import type { Services } from '@app/services';
import { INSTALL_STEPS } from '@app/pwa/pwa';
import { installLaunchConsumer } from '@app/pwa/launch';
import { showDialog } from '../../controls/Dialog';
import { addMenuItems, type DynamicMenuEntry } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { UpdatePrompt } from './UpdatePrompt';

/**
 * AGstudio as an installed app (src/app/pwa, src/sw): the install entry in the Help menu and the action search
 * (hidden once it runs as an app), the "Update ready" prompt, and the files the app is opened with.
 */
export const order = 90;

export const INSTALL_HINT =
  'Put AGstudio in its own window with a dock or Start-menu icon. It then starts without a browser tab, works offline, and opens .agproj projects when you double-click them';

export function register(services: Services): void {
  const { commands } = services;
  // Before anything else can delay it: Chrome offers the install prompt once, soon after the page loads.
  services.pwa.listen();
  commands.register({
    id: 'app.install',
    title: 'Install AGstudio as an app',
    category: 'Help',
    hint: INSTALL_HINT,
    // The browser's install prompt only opens after the musician's own click, and installing changes the computer,
    // not the project: Studio has nothing to do here.
    ai: false,
    // The Help menu lists it (and with it the action search) while AGstudio is not installed yet.
    palette: false,
    enabled: (s) => !s.pwa.store.getState().installed,
    run: async (s) => {
      const result = await s.pwa.install();
      if (result === 'accepted') s.session.getState().toast('Installing AGstudio: look for it in your dock, Launchpad or Start menu.');
      else if (result === 'manual') {
        await showDialog({
          title: 'Install AGstudio as an app',
          message: INSTALL_STEPS,
          detail: import.meta.env.DEV
            ? 'You are on the development server. For an app that also starts offline, run `agstudio --app` in a terminal and install from the page that opens.'
            : 'The installed app opens in its own window, starts without a browser tab and works offline. The AI studio still needs `agstudio --app` running.',
          buttons: [{ id: 'ok', label: 'OK', primary: true }],
          cancelId: 'ok',
        });
      }
    },
  });

  const entries = (): DynamicMenuEntry[] => {
    const { installed, updateReady } = services.pwa.store.getState();
    const out: DynamicMenuEntry[] = [];
    if (updateReady)
      out.push({
        label: 'Update ready — reload',
        hint: 'A new version of AGstudio is waiting: restart with it (not while a song plays)',
        disabled: services.engine.playing,
        run: () => services.pwa.applyUpdate(),
      });
    if (!installed)
      out.push({ label: 'Install AGstudio as an app', hint: INSTALL_HINT, run: () => void services.commands.run('app.install') });
    return out;
  };
  addMenuItems('help', [{ kind: 'dynamic', id: 'install-app', order: 21, entries }]);
  addOverlay('update-prompt', UpdatePrompt);

  if (typeof window === 'undefined') return; // Node tests
  // After the first paint (registerFeatures runs earlier): the worker registers and opened files arrive.
  requestAnimationFrame(() =>
    setTimeout(() => {
      services.pwa.start();
      installLaunchConsumer(services);
    }, 0),
  );
}
