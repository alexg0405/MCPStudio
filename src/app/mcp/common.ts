import type { Services } from '../services';
import type { ClientInfo, ToolResult } from './types';

/** What a tool handler gets besides its arguments. */
export interface ToolContext {
  client?: ClientInfo | undefined;
  /** Present on `export_audio` and `export_video`: lets them upload the files it renders to the dev server. */
  ticket?: string | undefined;
}

export type Args = Record<string, unknown>;
export type ToolFn = (s: Services, args: Args, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

/** Text for the AI, plus the same facts as data (clients that read `structuredContent` get exact values). */
export function ok(text: string, data?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) };
}

/** A failure the AI can react to (the call itself worked). */
export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** "claude-code" → "Claude Code": the app's own name for itself, made readable. */
export function clientLabel(c: ClientInfo | undefined): string {
  const name = c?.name?.trim();
  if (!name) return 'An AI app';
  if (/^claude[-_ ]?code$/i.test(name)) return 'Claude Code';
  if (/^claude[-_ ]?ai$/i.test(name)) return 'Claude';
  if (/^[a-z0-9]+([-_ .][a-z0-9]+)*$/.test(name))
    return name
      .split(/[-_ ]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  return name;
}

export const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** `{ from_bar, to_bar }` → bars (1-based, inclusive), or undefined / an error text. */
export function barsArg(v: unknown): { from: number; to: number } | undefined | string {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null) return 'bars must be { from_bar, to_bar }';
  const o = v as Args;
  const from = int(o.from_bar);
  const to = int(o.to_bar);
  if (from === undefined || to === undefined || from < 1) return 'from_bar and to_bar must be bar numbers starting at 1';
  if (to < from) return 'to_bar must not be before from_bar';
  return { from, to };
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
