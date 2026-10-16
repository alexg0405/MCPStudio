import type { ClientInfo, McpStatus } from '../../src/app/mcp/types.ts';

/** Who has been calling and how often, for the "Connected: Claude Code · 3 calls in the last minute" line. */
export class StatusTracker {
  private readonly clients = new Map<string, { name: string; version?: string; lastSeen: number; calls: number }>();
  private calls: number[] = [];
  private readonly listeners = new Set<() => void>();
  /** Tabs open on the app (set by the server from the bridge). */
  tabs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** An app said hello or called a tool. */
  touch(client: ClientInfo | undefined, call = false): void {
    const name = client?.name ?? 'An AI app';
    const t = this.now();
    const c = this.clients.get(name) ?? { name, lastSeen: t, calls: 0 };
    c.lastSeen = t;
    if (client?.version) c.version = client.version;
    if (call) {
      c.calls++;
      this.calls.push(t);
    }
    this.clients.set(name, c);
    this.emit();
  }

  /** Apps seen in the last ten minutes, newest first. */
  snapshot(): McpStatus {
    const t = this.now();
    this.calls = this.calls.filter((c) => c > t - 60_000);
    for (const [k, c] of this.clients) if (c.lastSeen < t - 600_000) this.clients.delete(k);
    return {
      clients: [...this.clients.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((c) => ({ ...c })),
      callsLastMinute: this.calls.length,
      tabs: this.tabs,
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
