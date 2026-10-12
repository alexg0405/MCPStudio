import { CommandRegistry } from '@core/commands/registry';
import { Keymap, type Platform } from '@core/commands/keymap';
import { createViewStore, type ViewStore } from './stores/view';
import { createSessionStore, type SessionStore } from './stores/session';

/**
 * The composition root. Built once at startup, outside React (StrictMode runs effects twice, so
 * long-lived objects like stores, the engine and the AudioContext must never be created in effects).
 * Features receive this object in their register() function and in commands.
 */
export interface Services {
  readonly platform: Platform;
  readonly commands: CommandRegistry<Services>;
  readonly keymap: Keymap;
  readonly view: ViewStore;
  readonly session: SessionStore;
  /** Fires after any store or registry changes; used to refresh command enabled/checked state. */
  subscribe(fn: () => void): () => void;
}

export function detectPlatform(): Platform {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
}

export function createServices(opts: { platform?: Platform } = {}): Services {
  const platform = opts.platform ?? detectPlatform();
  const commands = new CommandRegistry<Services>();
  const keymap = new Keymap(platform);
  const view = createViewStore();
  const session = createSessionStore();
  const services: Services = {
    platform,
    commands,
    keymap,
    view,
    session,
    subscribe(fn) {
      const unsubs = [commands.subscribe(fn), keymap.subscribe(fn), view.subscribe(fn), session.subscribe(fn)];
      return () => unsubs.forEach((u) => u());
    },
  };
  commands.bindContext(() => services);
  commands.onError = (id, err) => {
    console.error(`Command ${id} failed`, err);
    services.session.getState().toast(`${id} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  };
  return services;
}
