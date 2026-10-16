/**
 * The page's end of the MCP connection (development server only). The dev server holds the MCP
 * endpoint (tools/mcp); this tab answers its calls over Vite's HMR WebSocket:
 *
 *   server → page   agstudio:mcp:call     { id, tab, name, args, client, ticket }
 *   page → server   agstudio:mcp:ack      { id }       at once, so a frozen tab is told apart from a slow tool
 *   page → server   agstudio:mcp:result   { id, ok, result | error }
 *   page → server   agstudio:mcp:hello    { tab, focused, enabled, project }  on load, reconnect, focus, settings
 *   server → page   agstudio:mcp:status   who is connected (for Settings)
 *
 * With several tabs open the server picks the one used most recently (each tab reports its focus) and
 * names it in the call; the others ignore it.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Services } from '../services';
import { clientLabel } from './common';
import { createMcpTools, type McpTools } from './tools';
import {
  BRIDGE_EVENTS,
  type BridgeCall,
  type BridgeHello,
  type BridgeResult,
  type ClientInfo,
  type McpInfo,
  type McpStatus,
} from './types';

/** The part of `import.meta.hot` this uses (tests pass a fake). */
export interface HotChannel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (data: any) => void): void;
  send(event: string, data?: unknown): void;
}

/** A file-dialog command an AI app asked for: the musician's click starts it. */
export interface PendingGesture {
  id: number;
  client: string;
  commandId: string;
  args: unknown;
}

export interface McpLinkState {
  /** The dev server answered: there is an MCP endpoint to connect to. */
  available: boolean;
  /** The access token (null until the server told us). */
  token: string | null;
  /** The AGstudio folder and the export folder, as paths on this computer. */
  root: string;
  exportsDir: string;
  status: McpStatus;
  /** Clicks AI apps are waiting for. */
  gestures: PendingGesture[];
}

const EMPTY_STATUS: McpStatus = { clients: [], callsLastMinute: 0, tabs: 0 };
let gestureSeq = 0;

export interface McpLinkDeps {
  fetch?: typeof fetch;
  tools?: McpTools;
  tabId?: string;
}

export class McpLink {
  readonly store: StoreApi<McpLinkState>;
  readonly tools: McpTools;
  readonly tabId: string;
  private hot: HotChannel | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly seen = new Set<string>();
  private helloTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly s: Services,
    deps: McpLinkDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
    this.tabId = deps.tabId ?? globalThis.crypto.randomUUID();
    this.tools =
      deps.tools ??
      createMcpTools(s, {
        gesture: (client, commandId, args) => this.askForClick(client, commandId, args),
      });
    this.store = createStore<McpLinkState>()(() => ({
      available: false,
      token: null,
      root: '',
      exportsDir: '',
      status: EMPTY_STATUS,
      gestures: [],
    }));
  }

  /** Connects to the dev server's channel. Without one (a production build) nothing happens. */
  start(hot: HotChannel | undefined): void {
    if (!hot || this.hot) return;
    this.hot = hot;
    hot.on(BRIDGE_EVENTS.call, (call: BridgeCall) => void this.onCall(call));
    hot.on(BRIDGE_EVENTS.status, (status: McpStatus) => this.store.setState({ status }));
    // The dev server restarted (or the socket came back): tell it we are here again.
    hot.on('vite:ws:connect', () => {
      this.hello();
      void this.refresh();
    });
    this.s.prefs.subscribe((next, prev) => {
      if (next.mcpEnabled !== prev.mcpEnabled) this.hello();
    });
    this.s.files.store.subscribe((next, prev) => {
      if (next.name !== prev.name) this.scheduleHello();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => this.hello(true));
      // Using this tab (even while another window has the keyboard) makes it the one that answers.
      let last = 0;
      window.addEventListener(
        'pointerdown',
        () => {
          if (Date.now() - last < 1500) return;
          last = Date.now();
          this.hello(true);
        },
        { capture: true, passive: true },
      );
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.hello(true);
      });
      window.addEventListener('pagehide', () => hot.send(BRIDGE_EVENTS.bye, { tab: this.tabId }));
    }
    this.hello();
    void this.refresh();
  }

  /** Tells the server this tab exists, whether it is the one being used, and whether MCP is switched on. */
  hello(used = false): void {
    if (!this.hot) return;
    const focused = used || typeof document === 'undefined' || document.hasFocus();
    const hello: BridgeHello = {
      tab: this.tabId,
      focused,
      enabled: this.s.prefs.getState().mcpEnabled,
      project: this.s.files.store.getState().name,
      ...(typeof document !== 'undefined' ? { title: document.title } : {}),
    };
    this.hot.send(BRIDGE_EVENTS.hello, hello);
  }

  private scheduleHello(): void {
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => this.hello(), 400);
  }

  /** Reads the token and the connection status from the dev server. */
  async refresh(): Promise<void> {
    try {
      const res = await this.fetchImpl('/api/mcp/info', { headers: { 'x-agstudio': '1' } });
      if (!res.ok) return;
      const info = (await res.json()) as McpInfo;
      this.store.setState({ available: true, token: info.token, root: info.root, exportsDir: info.exportsDir, status: info.status });
    } catch {
      /* no dev server behind this page */
    }
  }

  /** A new token: the apps that had the old one are locked out. */
  async regenerateToken(): Promise<void> {
    const res = await this.fetchImpl('/api/mcp/token', { method: 'POST', headers: { 'x-agstudio': '1' } });
    if (!res.ok) throw new Error('The dev server did not make a new token.');
    this.store.setState({ token: ((await res.json()) as { token: string }).token });
  }

  private async onCall(call: BridgeCall): Promise<void> {
    if (call.tab !== this.tabId) return;
    this.hot?.send(BRIDGE_EVENTS.ack, { id: call.id });
    let reply: BridgeResult;
    try {
      if (!this.s.prefs.getState().mcpEnabled)
        throw new Error('The musician switched off connections from AI apps (Options → Settings → Connect AI apps).');
      this.greet(call.client);
      const result = await this.tools.call(call.name, call.args, { client: call.client, ticket: call.ticket });
      reply = { id: call.id, ok: true, result };
    } catch (e) {
      reply = { id: call.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.hot?.send(BRIDGE_EVENTS.result, reply);
  }

  /** A short toast the first time an app calls, so the musician notices the connection. */
  private greet(client: ClientInfo | undefined): void {
    const name = clientLabel(client);
    if (this.seen.has(name)) return;
    this.seen.add(name);
    this.s.session.getState().toast(`${name} is connected over MCP. What it changes shows in Studio, with Undo.`);
  }

  private askForClick(client: string, commandId: string, args: unknown): void {
    const g: PendingGesture = { id: ++gestureSeq, client, commandId, args };
    this.store.setState((st) => ({ gestures: [...st.gestures, g] }));
  }

  /** The musician dealt with a waiting click (ran it or dismissed it). */
  resolveGesture(id: number): PendingGesture | undefined {
    const g = this.store.getState().gestures.find((x) => x.id === id);
    if (g) this.store.setState((st) => ({ gestures: st.gestures.filter((x) => x.id !== id) }));
    return g;
  }
}
