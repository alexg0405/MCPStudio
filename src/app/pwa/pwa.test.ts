import { describe, expect, it, vi } from 'vitest';
import { INSTALL_STEPS, Pwa, type PwaEnv } from './pwa';

/** A stand-in for window: dispatches the events the service listens for. */
class FakeTarget extends EventTarget {}

interface FakeWorkerState {
  state: string;
}
class FakeWorker extends EventTarget implements FakeWorkerState {
  state = 'installing';
  readonly posted: unknown[] = [];
  postMessage(m: unknown) {
    this.posted.push(m);
  }
}
class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  updated = 0;
  update() {
    this.updated++;
    return Promise.resolve();
  }
}
class FakeContainer extends EventTarget {
  controller: object | null = null;
  registered: { url: string; options: unknown }[] = [];
  readonly reg = new FakeRegistration();
  stale: { unregister: () => Promise<boolean> }[] = [];
  readyPromise = Promise.resolve(this.reg);
  get ready() {
    return this.readyPromise;
  }
  register(url: string, options: unknown) {
    this.registered.push({ url, options });
    return Promise.resolve(this.reg);
  }
  getRegistrations() {
    return Promise.resolve(this.stale);
  }
}

function setup(over: { standalone?: boolean; production?: boolean; early?: Event } = {}) {
  const target = new FakeTarget();
  const container = new FakeContainer();
  const reload = vi.fn();
  const env: PwaEnv = {
    target,
    matchMedia: (q) => ({ matches: !!over.standalone && q === '(display-mode: standalone)' }),
    production: over.production ?? true,
    serviceWorker: container as unknown as ServiceWorkerContainer,
    reload,
    ...(over.early ? { earlyPrompt: () => over.early } : {}),
  };
  return { pwa: new Pwa(env), target, container, reload };
}

/** Chrome's install prompt event. */
function promptEvent(outcome: 'accepted' | 'dismissed') {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
  e.prompt = vi.fn(() => Promise.resolve());
  e.userChoice = Promise.resolve({ outcome });
  return e;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('installing the app', () => {
  it('is not installed in a browser tab, and is in an app window', () => {
    expect(setup().pwa.store.getState().installed).toBe(false);
    expect(setup({ standalone: true }).pwa.store.getState().installed).toBe(true);
  });

  it('keeps Chrome’s install prompt for the menu entry and opens it once, on request', async () => {
    const { pwa, target } = setup();
    pwa.start();
    const e = promptEvent('accepted');
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true); // no mini-infobar of its own
    expect(pwa.store.getState().canPrompt).toBe(true);
    expect(await pwa.install()).toBe('accepted');
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(pwa.store.getState().canPrompt).toBe(false);
    // A prompt can be used once: the next ask falls back to the browser's own steps.
    expect(await pwa.install()).toBe('manual');
  });

  it('reports a dismissed prompt', async () => {
    const { pwa, target } = setup();
    pwa.start();
    target.dispatchEvent(promptEvent('dismissed'));
    expect(await pwa.install()).toBe('dismissed');
  });

  it('says to follow the browser’s steps when no prompt was offered', async () => {
    const { pwa } = setup();
    pwa.start();
    expect(await pwa.install()).toBe('manual');
    expect(INSTALL_STEPS).toMatch(/install icon/);
  });

  it('picks up a prompt that fired before the app’s code ran', async () => {
    const early = promptEvent('accepted');
    const { pwa } = setup({ early });
    pwa.listen();
    expect(pwa.store.getState().canPrompt).toBe(true);
    expect(await pwa.install()).toBe('accepted');
  });

  it('is installed once the browser says so, and installing again does nothing', async () => {
    const { pwa, target } = setup();
    pwa.start();
    target.dispatchEvent(promptEvent('accepted'));
    target.dispatchEvent(new Event('appinstalled'));
    expect(pwa.store.getState()).toMatchObject({ installed: true, canPrompt: false });
    expect(await pwa.install()).toBe('installed');
  });
});

describe('the service worker', () => {
  it('is registered in a production build, at the site root, always checking for a new file', async () => {
    const { pwa, container } = setup();
    pwa.start();
    await flush();
    expect(container.registered).toEqual([{ url: '/sw.js', options: { scope: '/', updateViaCache: 'none' } }]);
    expect(pwa.store.getState().offlineReady).toBe(true);
    pwa.start();
    await flush();
    expect(container.registered).toHaveLength(1);
  });

  it('is never registered in development, which removes a stale one instead', async () => {
    const { pwa, container } = setup({ production: false });
    const unregister = vi.fn(() => Promise.resolve(true));
    container.stale = [{ unregister }];
    pwa.start();
    await flush();
    expect(container.registered).toEqual([]);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('offers no update on the very first install (nothing was running before)', async () => {
    const { pwa, container } = setup();
    pwa.start();
    await flush();
    const worker = new FakeWorker();
    container.reg.installing = worker;
    container.reg.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    worker.dispatchEvent(new Event('statechange'));
    expect(pwa.store.getState().updateReady).toBe(false);
  });

  it('offers an update when a new version finishes installing under a running one, and reloads only when told to', async () => {
    const { pwa, container, reload } = setup();
    container.controller = {};
    pwa.start();
    await flush();
    const worker = new FakeWorker();
    container.reg.installing = worker;
    container.reg.dispatchEvent(new Event('updatefound'));
    worker.state = 'installing';
    worker.dispatchEvent(new Event('statechange'));
    expect(pwa.store.getState().updateReady).toBe(false);
    worker.state = 'installed';
    container.reg.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    expect(pwa.store.getState().updateReady).toBe(true);
    // The worker taking over by itself (another tab) must not reload this one.
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    pwa.applyUpdate();
    expect(worker.posted).toEqual(['agstudio:skip-waiting']);
    expect(reload).not.toHaveBeenCalled(); // waits for the new worker to take over
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers a version that was already waiting from an earlier visit', async () => {
    const { pwa, container } = setup();
    container.controller = {};
    container.reg.waiting = new FakeWorker();
    pwa.start();
    await flush();
    expect(pwa.store.getState().updateReady).toBe(true);
  });

  it('applyUpdate with nothing waiting does nothing', () => {
    const { pwa, reload } = setup();
    pwa.applyUpdate();
    expect(reload).not.toHaveBeenCalled();
  });
});
