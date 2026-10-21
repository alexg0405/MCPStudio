/** What the beat assistant asks the dev server for, and what it gets back. */
export type BackendId = 'subscription' | 'api' | 'codex';

/**
 * The longest system prompt and turn text the dev server takes (characters). Guards against runaway requests, not a model
 * limit: the text reaches the Claude and Codex CLIs on stdin and the API as a message. The system prompt carries the rules and
 * the catalog index (about 78 000 characters with every built-in plugin and command); a turn's text is the request, the
 * project and the details of what the request needs. These leave room to grow.
 */
export const MAX_SYSTEM_CHARS = 120_000;
export const MAX_TEXT_CHARS = 400_000;

export interface BeatRequest {
  backend: BackendId;
  /** A Claude model id; for the codex backend a Codex model id, or empty for Codex's own default. */
  model: string;
  /** The conversation so far (from an earlier reply), or null for a new one. */
  session: string | null;
  system: string;
  /**
   * The blocks `system` is made of (the rules, then the catalog index): joined with a blank line they are `system`. The API
   * backend puts a cache breakpoint after each, so a changed index still reuses the cached rules. Ignored when they do not
   * add up to `system`.
   */
  systemBlocks?: string[];
  /** JSON schema the answer must follow (structured output). */
  schema: Record<string, unknown>;
  /** This turn's user message. */
  text: string;
  /**
   * The page can answer read-tool calls (MCP is on in its settings): the backend lets the AI look things up during the
   * turn. Without it the AI looks things up with a query action, as it always could.
   */
  readTools?: boolean;
}

/**
 * How a backend reaches AGstudio's read tools during one turn. The server makes it per request (the page never sends it): it
 * names this dev server's read-only MCP endpoint and the program that talks to it, and it holds no secret. The access token
 * stays in its file: the helper program reads it there, so no config file, command line or log of a backend has it.
 */
export interface LookupAccess {
  /** The read-only MCP endpoint on this dev server (loopback; `?scope=lookup` offers only the read tools). */
  url: string;
  /** The file holding the access token. */
  tokenFile: string;
  /** The program that speaks MCP over stdio and forwards to `url` (Node), and its arguments (the helper script). */
  command: string;
  args: string[];
  /** The read tools the AI may call, by name. */
  tools: readonly string[];
}

export interface BeatReply {
  session: string;
  /** The parsed JSON answer (the app validates it). */
  beat: unknown;
  model: string;
}

export interface BackendStatus {
  ok: boolean;
  /** Why it isn't available, in words for the musician. */
  reason?: string;
}

export interface Backend {
  status(): Promise<BackendStatus>;
  /** `lookup`: the read tools the AI may call during this turn (the request asked for them and the server can offer them). */
  beat(req: BeatRequest, signal: AbortSignal, lookup?: LookupAccess): Promise<BeatReply>;
}

/** A failure with a message meant for the musician; `type` lets the app react (e.g. not_configured). */
export class AiServerError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AiServerError';
  }
}

/** Server-side conversations: kept in memory for a while, oldest dropped first. */
export class Sessions<T> {
  private readonly map = new Map<string, { value: T; used: number }>();
  constructor(
    private readonly max = 40,
    private readonly ttlMs = 6 * 3600_000,
  ) {}

  get(id: string | null): T | undefined {
    if (!id) return undefined;
    const hit = this.map.get(id);
    if (!hit || Date.now() - hit.used > this.ttlMs) return undefined;
    return hit.value;
  }

  set(id: string, value: T): void {
    this.map.delete(id);
    this.map.set(id, { value, used: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}
