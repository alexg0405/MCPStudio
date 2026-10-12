import { CommandRegistry } from '@core/commands/registry';
import { Keymap, type Platform } from '@core/commands/keymap';
import type { History } from '@core/history/history';
import type { PluginOwner, Project } from '@core/model/types';
import { setPluginState } from '@core/ops/channels';
import type { JsonValue } from '@agstudio/sdk';
import type { EngineApi, EngineOptions } from '@engine/api';
import { Engine } from '@engine/engine';
import { createDefaultProject } from './default-project';
import { registerBuiltinPlugins } from './plugins/discover';
import { PluginRegistry } from './plugins/registry';
import { createDoc, type DocStore } from './stores/doc';
import { createSessionStore, type SessionStore } from './stores/session';
import { createViewStore, type ViewStore } from './stores/view';

/**
 * The composition root. Built once at startup, outside React (StrictMode runs effects twice, so
 * long-lived objects like stores, the engine and the AudioContext must never be created in effects).
 * Features receive this object in their register() function and in commands.
 */
export interface Services {
  readonly platform: Platform;
  readonly commands: CommandRegistry<Services>;
  readonly keymap: Keymap;
  /** The project document (read with useDoc; write only through `history`). */
  readonly doc: DocStore;
  readonly history: History;
  readonly view: ViewStore;
  readonly session: SessionStore;
  readonly plugins: PluginRegistry;
  readonly engine: EngineApi;
  /** Fires after any store, registry or engine change; used to refresh command enabled/checked state. */
  subscribe(fn: () => void): () => void;
}

export function detectPlatform(): Platform {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
}

export interface ServiceOptions {
  platform?: Platform;
  /** Inject an engine (tests use a fake); default is a realtime Web Audio engine. */
  createEngine?: (opts: EngineOptions) => EngineApi;
  project?: Project;
}

export function createServices(opts: ServiceOptions = {}): Services {
  const platform = opts.platform ?? detectPlatform();
  const commands = new CommandRegistry<Services>();
  const keymap = new Keymap(platform);
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  const { store: doc, history } = createDoc(opts.project ?? createDefaultProject(plugins));
  const view = createViewStore({ currentPatternId: doc.getState().project.patternOrder[0] ?? null });
  const session = createSessionStore();
  session.getState().selectChannel(doc.getState().project.channelOrder[0] ?? null);

  const engineOptions: EngineOptions = {
    plugins,
    onPluginStateRequest: (owner: PluginOwner, state: JsonValue) =>
      history.transact('Plugin state', (d) => setPluginState(d, owner, state)),
    onPluginFault: (_owner, pluginId, error) => {
      const message = error === 'missing' ? `Plugin "${pluginId}" is not installed` : `Plugin "${pluginId}" failed`;
      console.error(message, error);
      session.getState().toast(message, 'error');
    },
  };
  const engine = (opts.createEngine ?? ((o) => Engine.realtime(o)))(engineOptions);

  const services: Services = {
    platform,
    commands,
    keymap,
    doc,
    history,
    view,
    session,
    plugins,
    engine,
    subscribe(fn) {
      const unsubs = [
        commands.subscribe(fn),
        keymap.subscribe(fn),
        view.subscribe(fn),
        session.subscribe(fn),
        history.onStatus(fn),
        engine.subscribe(fn),
      ];
      return () => unsubs.forEach((u) => u());
    },
  };
  commands.bindContext(() => services);
  commands.onError = (id, err) => {
    console.error(`Command ${id} failed`, err);
    session.getState().toast(`${id} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  };

  connectEngine(services);
  return services;
}

/** Keeps the engine in sync with the document and the transport view. */
function connectEngine(s: Services): void {
  const { engine, history, view, doc } = s;
  const project = doc.getState().project;
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  history.onChange((change) => engine.applyDocChange(change));

  const pushView = () => {
    const v = view.getState();
    engine.setTransportView({ mode: v.mode, patternId: v.currentPatternId, loop: null });
  };
  pushView();
  view.subscribe((next, prev) => {
    if (next.mode !== prev.mode || next.currentPatternId !== prev.currentPatternId) pushView();
  });

  // Keep the current pattern and selected channel valid as the document changes.
  history.onChange(({ next }) => {
    const v = view.getState();
    if (!v.currentPatternId || !next.patterns[v.currentPatternId]) v.setCurrentPattern(next.patternOrder[0] ?? null);
    const sel = s.session.getState().selectedChannelId;
    if (sel && !next.channels[sel]) s.session.getState().selectChannel(next.channelOrder[0] ?? null);
  });
}
