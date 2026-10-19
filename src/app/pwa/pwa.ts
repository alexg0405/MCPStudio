import { createStore, type StoreApi } from 'zustand/vanilla';
import { SKIP_WAITING_MESSAGE } from '@sw/routing';

/**
 * The installable app (docs/architecture.md, "Installable app (PWA)"), page side: is AGstudio running as an installed
 * app, can Chrome install it from here (beforeinstallprompt), and the service worker's life: registered in production
 * builds only (never in development, where it would stand in front of Vite's hot reload), an update waiting to
 * take over, and the reload the musician chooses when they are ready.
 */
export interface PwaState {
  /** Running in an app window (display-mode standalone / window controls overlay), not a browser tab. */
  installed: boolean;
  /** Chrome offered its install prompt for this page: `install()` opens it. */
  canPrompt: boolean;
  /** The service worker has cached the app: it starts offline. */
  offlineReady: boolean;
  /** A new version is downloaded and waiting: `applyUpdate()` reloads into it. */
  updateReady: boolean;
}

/** Chrome's install prompt event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** What `install()` did. `manual`: Chrome gave no prompt, so the musician follows the steps (see installSteps). */
export type InstallResult = 'accepted' | 'dismissed' | 'manual' | 'installed';

/** The browser pieces the service uses, so tests can stand in for them. */
export interface PwaEnv {
  /** window: install events and reload. */
  target: Pick<EventTarget, 'addEventListener'>;
  matchMedia(query: string): { matches: boolean };
  /** Production builds only: development never registers a worker (and removes a stale one). */
  production: boolean;
  serviceWorker: ServiceWorkerContainer | undefined;
  reload(): void;
  /** An install prompt that fired before the app's code ran (index.html keeps it on `window.__agInstallPrompt`). */
  earlyPrompt?(): Event | undefined;
}

const DISPLAY_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'] as const;

/** The check interval for a new version (an app window can stay open for days). */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function browserEnv(): PwaEnv {
  // Node tests build services too: with no window there is nothing to install and no worker.
  if (typeof window === 'undefined')
    return { target: { addEventListener() {} }, matchMedia: () => ({ matches: false }), production: false, serviceWorker: undefined, reload() {} };
  return {
    target: window,
    matchMedia: (q) => window.matchMedia(q),
    production: !import.meta.env.DEV,
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    reload: () => window.location.reload(),
    earlyPrompt: () => (window as { __agInstallPrompt?: Event }).__agInstallPrompt,
  };
}

export class Pwa {
  readonly store: StoreApi<PwaState>;
  private deferred: BeforeInstallPromptEvent | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private listening = false;
  private started = false;

  constructor(private readonly env: PwaEnv = browserEnv()) {
    this.store = createStore<PwaState>()(() => ({
      installed: this.isInstalledWindow(),
      canPrompt: false,
      offlineReady: false,
      updateReady: false,
    }));
  }

  /**
   * Listens for Chrome's install prompt. Call it as early as possible: the event fires once, soon after the page loads.
   * Safe to call twice.
   */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    const { target } = this.env;
    const keep = (e: Event) => {
      // Keep it for the menu entry instead of Chrome's own mini-infobar.
      e.preventDefault();
      this.deferred = e as BeforeInstallPromptEvent;
      this.store.setState({ canPrompt: true });
    };
    const early = this.env.earlyPrompt?.();
    if (early) keep(early);
    target.addEventListener('beforeinstallprompt', keep);
    target.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.store.setState({ installed: true, canPrompt: false });
    });
  }

  /** Listens, and registers the service worker (production builds). Safe to call twice. */
  start(): void {
    this.listen();
    if (this.started) return;
    this.started = true;
    const sw = this.env.serviceWorker;
    if (!sw) return;
    if (this.env.production) void this.register(sw);
    else void this.removeStaleWorker(sw);
  }

  private isInstalledWindow(): boolean {
    const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined;
    return nav?.standalone === true || DISPLAY_MODES.some((m) => this.env.matchMedia(`(display-mode: ${m})`).matches);
  }

  /** Opens Chrome's install prompt when it offered one; otherwise says to use the browser's own install entry. */
  async install(): Promise<InstallResult> {
    if (this.store.getState().installed) return 'installed';
    const event = this.deferred;
    if (!event) return 'manual';
    // A prompt can be used once.
    this.deferred = null;
    this.store.setState({ canPrompt: false });
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  }

  /** Reloads into the waiting version (the musician asked for it: nothing reloads by itself). */
  applyUpdate(): void {
    const sw = this.env.serviceWorker;
    const waiting = this.registration?.waiting;
    if (!sw || !waiting) return;
    sw.addEventListener('controllerchange', () => this.env.reload(), { once: true });
    waiting.postMessage(SKIP_WAITING_MESSAGE);
  }

  private async register(sw: ServiceWorkerContainer): Promise<void> {
    try {
      const reg = await sw.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      this.registration = reg;
      // A version that was waiting from an earlier visit, or one that finishes installing now. (Without a controller
      // this is the first install: nothing to update, the worker simply becomes the app's offline copy.)
      if (reg.waiting && sw.controller) this.store.setState({ updateReady: true });
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && sw.controller) this.store.setState({ updateReady: true });
        });
      });
      void sw.ready.then(() => this.store.setState({ offlineReady: true }));
      if (typeof document !== 'undefined') {
        const check = () => void reg.update().catch(() => {});
        setInterval(check, UPDATE_CHECK_MS);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      }
    } catch (e) {
      console.warn('AGstudio could not register its service worker; it will not start offline.', e);
    }
  }

  /**
   * Development: a worker left by a production build served on this same address would stand in front of the dev
   * server. Remove it (and its caches) so the dev workflow always sees the real files.
   */
  private async removeStaleWorker(sw: ServiceWorkerContainer): Promise<void> {
    try {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      if (typeof caches !== 'undefined')
        for (const name of await caches.keys()) if (name.startsWith('agstudio-')) await caches.delete(name);
    } catch {
      /* nothing to clean up */
    }
  }
}

/** The steps for Chrome's own install entry, for when it offers no prompt (already dismissed, or another browser). */
export const INSTALL_STEPS =
  'In Chrome or Edge, click the install icon at the right end of the address bar (a screen with a down arrow), or open the ⋮ menu: in Chrome choose “Cast, save and share” → “Install AGstudio…”, in Edge “Apps” → “Install this site as an app”.';
