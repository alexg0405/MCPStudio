import { readFile } from 'node:fs/promises';
import type { LookupAccess } from './types.ts';

/**
 * A small MCP client for the API backend's tool loop: it lists the read tools of AGstudio's read-only endpoint and calls
 * them, over plain JSON-RPC on HTTP, from this server (the API key never leaves it and neither does the access token: it is
 * read from its file for every call and sent only to the endpoint on this machine). The CLI backends do not need it: their
 * CLIs speak MCP themselves (lookup.ts).
 *
 * The endpoint answers without a handshake (it serves a request that carries no session), so two calls are all it takes.
 */

/** A read tool as the model is told about it. */
export interface LookupTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a call returned: the text the model reads, and whether the tool said it failed. */
export interface LookupResult {
  text: string;
  isError: boolean;
}

/** How long one request to the endpoint may take: reads are quick, but the page may be busy for a moment. */
const REQUEST_TIMEOUT_MS = 65_000;

/** A failure to reach the tools (as opposed to a tool that says its arguments were wrong). */
export class LookupUnavailableError extends Error {}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export class McpLookupClient {
  private nextId = 1;

  constructor(
    private readonly access: LookupAccess,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** The read tools the endpoint offers, in its order (the order is part of the cached prompt: it must not vary). */
  async listTools(signal?: AbortSignal): Promise<LookupTool[]> {
    const result = await this.request('tools/list', {}, signal);
    const tools = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools.filter(isObject).flatMap((tool) =>
      typeof tool.name === 'string'
        ? [
            {
              name: tool.name,
              description: typeof tool.description === 'string' ? tool.description : '',
              inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
            },
          ]
        : [],
    );
  }

  /** Calls one tool. Throws LookupUnavailableError when the endpoint or the page cannot be reached. */
  async callTool(name: string, args: Json, signal?: AbortSignal): Promise<LookupResult> {
    const result = await this.request('tools/call', { name, arguments: args }, signal);
    const content = isObject(result) && Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter(isObject)
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n');
    return { text, isError: isObject(result) && result.isError === true };
  }

  /** One JSON-RPC request to the endpoint; its `result`. */
  private async request(method: string, params: Json, signal?: AbortSignal): Promise<unknown> {
    const token = (await readFile(this.access.tokenFile, 'utf8').catch(() => '')).trim();
    if (!token) throw new LookupUnavailableError('AGstudio has no access token yet');
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(this.access.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new LookupUnavailableError(`AGstudio's read tools did not answer: ${error instanceof Error ? error.message : error}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LookupUnavailableError(`AGstudio's read tools answered ${res.status}: ${text.trim().slice(0, 200)}`);
    }
    if (isObject(body) && isObject(body.error)) {
      throw new LookupUnavailableError(`AGstudio's read tools said: ${String(body.error.message ?? 'an error')}`);
    }
    return isObject(body) ? body.result : undefined;
  }
}
