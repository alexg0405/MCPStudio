/** What the beat assistant asks the dev server for, and what it gets back. */
export type BackendId = 'subscription' | 'api';

export interface BeatRequest {
  backend: BackendId;
  model: string;
  /** The conversation so far (from an earlier reply), or null for a new one. */
  session: string | null;
  system: string;
  /** JSON schema the answer must follow (structured output). */
  schema: Record<string, unknown>;
  /** This turn's user message. */
  text: string;
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
  beat(req: BeatRequest, signal: AbortSignal): Promise<BeatReply>;
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
