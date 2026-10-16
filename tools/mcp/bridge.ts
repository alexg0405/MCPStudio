import { randomUUID } from 'node:crypto';
import {
  BRIDGE_EVENTS,
  type BridgeCall,
  type BridgeHello,
  type BridgeResult,
  type ClientInfo,
  type ToolResult,
} from '../../src/app/mcp/types.ts';

/**
 * The dev server can't edit the project: it lives in the browser tab. The bridge relays each tool
 * call to the open AGstudio tab over Vite's HMR WebSocket and waits for the answer.
 *
 *  - With several tabs open, the one the musician used most recently answers (tabs report focus);
 *    the call names that tab and the others ignore it.
 *  - The tab confirms receipt at once (`ack`), so a frozen or missing tab is told apart from a long
 *    tool: no ack within `ackTimeoutMs` is an error, a slow answer is waited for until `timeoutMs`.
 *  - A tab that closes mid-call fails the call right away.
 */

/** One browser tab's connection (a Vite WebSocket client). */
export interface TabSocket {
  send(event: string, data: unknown): void;
  isOpen(): boolean;
}

export class BridgeError extends Error {}

interface Tab extends BridgeHello {
  socket: TabSocket;
  lastFocus: number;
  lastSeen: number;
}

interface Pending {
  tab: string;
  socket: TabSocket;
  acked: boolean;
  resolve(r: ToolResult): void;
  reject(e: Error): void;
  timers: ReturnType<typeof setTimeout>[];
  poll: ReturnType<typeof setInterval>;
}

export interface BridgeOptions {
  /** What to tell the musician when no tab is open ("Open AGstudio in the browser first: …"). */
  openHint(): string;
  ackTimeoutMs?: number;
  now?: () => number;
}

export class McpBridge {
  private readonly tabs = new Map<string, Tab>();
  private readonly pending = new Map<string, Pending>();
  private readonly ackTimeout: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: BridgeOptions) {
    this.ackTimeout = opts.ackTimeoutMs ?? 4000;
    this.now = opts.now ?? Date.now;
  }

  /** A tab says hello (when it loads, reconnects, gains focus or changes a setting). */
  hello(socket: TabSocket, h: BridgeHello): void {
    const t = this.now();
    const known = this.tabs.get(h.tab);
    this.tabs.set(h.tab, {
      ...h,
      socket,
      lastSeen: t,
      // A tab that reports focus becomes the one that answers; a new tab that is not focused queues behind.
      lastFocus: h.focused ? t : (known?.lastFocus ?? 0),
    });
    // Only a new tab or a changed setting is news (a click in a known tab just updates who answers).
    if (!known || known.enabled !== h.enabled || known.project !== h.project) this.emit();
  }

  bye(tab: string): void {
    if (this.tabs.delete(tab)) this.emit();
  }

  ack(id: string): void {
    const p = this.pending.get(id);
    if (p) p.acked = true;
  }

  /** The page's answer to a call. */
  result(r: BridgeResult): void {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.finish(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(new BridgeError(r.error));
  }

  /** Tabs that are still connected, most recently used first. */
  open(): (BridgeHello & { lastFocus: number })[] {
    for (const [id, t] of this.tabs) if (!t.socket.isOpen()) this.tabs.delete(id);
    return [...this.tabs.values()].sort((a, b) => b.lastFocus - a.lastFocus || b.lastSeen - a.lastSeen);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Runs a tool in the answering tab. Rejects with a message meant for the AI (and the musician). */
  call(
    name: string,
    args: Record<string, unknown>,
    meta: { client?: ClientInfo | undefined; ticket?: string | undefined } = {},
    timeoutMs = 60_000,
  ): Promise<ToolResult> {
    const tab = this.open()[0];
    if (!tab) return Promise.reject(new BridgeError(this.opts.openHint()));
    const live = this.tabs.get(tab.tab)!;
    if (!live.enabled)
      return Promise.reject(
        new BridgeError(
          'The musician has switched off connections from AI apps (Options → Settings → Connect AI apps). Ask them to switch it back on.',
        ),
      );
    const id = randomUUID();
    return new Promise<ToolResult>((resolve, reject) => {
      const p: Pending = {
        tab: tab.tab,
        socket: live.socket,
        acked: false,
        resolve,
        reject,
        timers: [],
        poll: setInterval(() => {
          if (!live.socket.isOpen()) {
            this.finish(id);
            reject(new BridgeError('The AGstudio tab was closed while it was working. Open it again and retry.'));
          }
        }, 1000),
      };
      p.timers.push(
        setTimeout(() => {
          if (p.acked) return;
          this.finish(id);
          reject(
            new BridgeError(
              'The AGstudio tab did not answer. It may be frozen, or the browser is holding it in the background: switch to it, then retry.',
            ),
          );
        }, this.ackTimeout),
        setTimeout(() => {
          this.finish(id);
          reject(new BridgeError(`${name} is taking longer than ${Math.round(timeoutMs / 1000)} s. AGstudio may still be working on it: check with get_project before retrying.`));
        }, timeoutMs),
      );
      this.pending.set(id, p);
      const call: BridgeCall = {
        id,
        tab: tab.tab,
        name,
        args,
        ...(meta.client ? { client: meta.client } : {}),
        ...(meta.ticket ? { ticket: meta.ticket } : {}),
      };
      try {
        live.socket.send(BRIDGE_EVENTS.call, call);
      } catch (e) {
        this.finish(id);
        reject(new BridgeError(`Could not reach the AGstudio tab: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  private finish(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.timers.forEach(clearTimeout);
    clearInterval(p.poll);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Cancels everything in flight (the server is closing). */
  dispose(): void {
    for (const [id, p] of [...this.pending]) {
      this.finish(id);
      p.reject(new BridgeError('AGstudio is shutting down.'));
    }
    this.tabs.clear();
  }
}
