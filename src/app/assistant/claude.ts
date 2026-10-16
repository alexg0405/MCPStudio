import type { PerformanceRole } from '@core/beat/local';
import { BEAT_JSON_SCHEMA, validateBeatSpec, type BeatSpec } from '@core/beat/spec';

/**
 * The beat assistant's conversation with Claude. The dev server does the talking (tools/ai): either
 * through the musician's own Claude subscription (their signed-in Claude Code) or with an API key,
 * and keeps the conversation, so "make the hats busier" changes the last beat instead of starting
 * over. Claude answers with the beat as JSON (structured output); every answer is validated before
 * it touches the project.
 */

export { AI_MODELS, DEFAULT_MODEL } from './state';

/** How the assistant reaches Claude. */
export type AiBackend = 'subscription' | 'api';

export interface AiBackendStatus {
  ok: boolean;
  reason?: string;
}

export interface AiStatus {
  subscription: AiBackendStatus;
  api: AiBackendStatus;
}

export type AiErrorKind =
  'not-configured' | 'auth' | 'rate-limit' | 'overloaded' | 'refused' | 'network' | 'bad-output' | 'other';

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface PerformanceContext {
  /** The voice analysis summary of what the user performed (events on the grid). */
  summary: string;
  role: PerformanceRole;
  bars: number;
  bpm: number;
}

export const SYSTEM_PROMPT = `You are the beat assistant inside AGstudio, an FL Studio-style DAW. A musician describes the beat they want and may perform part of it with their voice (beatboxing drums, or humming a bass line or melody). You answer with one complete pattern as JSON in the required format; it goes straight into their project.

Grid: 4/4, 16 steps per bar (1/16 notes). Bar b, beat q (both 1-based) starts at step (b-1)*16 + (q-1)*4. Fractional steps make rolls: +0.5 is a 1/32 note, thirds give triplets. Lengths are in steps.

Sounds:
- Drum samples (no key): kick, snare, clap, hat (closed), open-hat, tom-low, tom-mid, tom-high, rim, cowbell, crash.
- 808: sine bass with an attack punch, drive and glide. A note that starts before the previous 808 note ends glides to its pitch (a slide). Settings via params: decay (s), glide (s), punch (semitones), drive (0–1), tone (Hz).
- bass (synth bass), lead, pad, pluck: pitched, need MIDI keys.

Make it sound like a finished, professional beat in the requested style:
- Tempos: trap 130–150 with a half-time feel (snare or clap on beat 3 of each bar); drill 140–145 with sliding 808s, snares on beat 3 and syncopated kicks; boom bap 85–95 with swing about 0.15; lofi 70–90, swung and soft; house 120–128, four on the floor; reggaeton about 95 (dembow).
- 808s sit around C1–C2 (MIDI 24–40), land the root on the downbeat, follow or answer the kick, ring long, and slide into new notes now and then. Stay in one key.
- Hats carry the groove: vary velocities (accents and ghost notes) and add 1/32 or triplet rolls into snares and bar ends in trap and drill.
- Give the last bar some variation (a fill, a roll, an 808 slide) so loops don't feel static.
- Leave headroom: omit volume unless a part should sit lower; the 808 is set around 0.6 so it and the kick don't clip together.
- 3–8 tracks; bars 1–4 (2 is a good default for trap and drill).

When the musician performed something, you get it as events on the grid, with the instrument they meant:
- Follow its rhythm closely and keep their steps; only clean up obvious timing slop.
- For hummed or sung notes, keep the melodic contour (the intervals and where it slides) but move it into the right register and key for that instrument.
- Build the rest of the beat around the performance so they fit together.

When they ask for a change ("busier hats", "make the 808 slide more", "add a clap"), send the whole beat again with only that changed and everything else exactly as in your previous beat.

The message field is one or two friendly sentences for the musician about what you made. No lists, no step numbers. Performance summaries name notes scientifically (C4 = MIDI 60); the key field is a MIDI number.

Example of the shape (2-bar trap in F minor; the 808 slides from F1 up to A♭1 in bar 2, the hats roll into the snare):
{"title":"Night drive","bpm":140,"bars":2,"tracks":[
 {"name":"Kick","sound":"kick","notes":[{"step":0},{"step":7},{"step":10},{"step":16},{"step":23,"vel":0.7},{"step":26}]},
 {"name":"Clap","sound":"clap","notes":[{"step":8},{"step":24}]},
 {"name":"Hat","sound":"hat","notes":[{"step":0},{"step":2,"vel":0.6},{"step":4},{"step":6,"vel":0.6},{"step":6.5,"len":0.5,"vel":0.5},{"step":7,"len":0.5,"vel":0.7},{"step":7.5,"len":0.5,"vel":0.8},{"step":10},{"step":12},{"step":14,"vel":0.6},{"step":16},{"step":18,"vel":0.6},{"step":20},{"step":22,"vel":0.6},{"step":24},{"step":26},{"step":28},{"step":29.33,"len":0.33,"vel":0.5},{"step":29.67,"len":0.33,"vel":0.6},{"step":30,"len":0.5,"vel":0.7},{"step":30.5,"len":0.5,"vel":0.8},{"step":31,"len":0.5,"vel":0.9},{"step":31.5,"len":0.5,"vel":1}]},
 {"name":"808","sound":"808","params":{"glide":0.09,"decay":2.2},"notes":[{"step":0,"len":7,"key":29},{"step":7,"len":3,"key":29},{"step":10,"len":6,"key":29},{"step":16,"len":7,"key":29},{"step":22,"len":4,"key":32},{"step":26,"len":6,"key":29}]}],
 "message":"A dark, bouncy trap loop: the hats roll into the clap and the 808 slides up at the end."}
(The 808 note at step 22 starts before the one at 16 ends, so it glides up.)`;

/** The performance block of a turn (what the musician beatboxed or hummed, on the grid). */
export function performanceBlock(performance: PerformanceContext): string {
  const meant = {
    auto: 'figure it out from the sounds',
    drums: 'drums (beatbox)',
    '808': 'the 808 bass line',
    melody: 'a melody',
  }[performance.role];
  return `<performance instrument="${meant}" bars="${performance.bars}" bpm="${performance.bpm}">\n${performance.summary}\n</performance>`;
}

function userText(prompt: string, project: string, performance?: PerformanceContext | null): string {
  let text = `<request>\n${prompt.trim() || 'Make a beat.'}\n</request>\n\n<project>\n${project}\n</project>`;
  if (performance) {
    const meant = {
      auto: 'figure it out from the sounds',
      drums: 'drums (beatbox)',
      '808': 'the 808 bass line',
      melody: 'a melody',
    }[performance.role];
    text += `\n\n<performance instrument="${meant}" bars="${performance.bars}" bpm="${performance.bpm}">\n${performance.summary}\n</performance>`;
  }
  return text;
}

async function errorFrom(res: Response): Promise<AiError> {
  let type = '';
  let message = `The AGstudio server answered with HTTP ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    type = body.error?.type ?? '';
    if (body.error?.message) message = body.error.message;
  } catch {
    /* not JSON */
  }
  const kinds: Record<string, AiErrorKind> = {
    not_configured: 'not-configured',
    not_signed_in: 'not-configured',
    authentication_error: 'auth',
    rate_limit_error: 'rate-limit',
    overloaded_error: 'overloaded',
    refusal: 'refused',
    connection_error: 'network',
    max_tokens: 'bad-output',
    bad_output: 'bad-output',
  };
  return new AiError(message, kinds[type] ?? (res.status === 429 ? 'rate-limit' : 'other'));
}

/**
 * A conversation with Claude through the AGstudio server: each turn sends a system prompt, a JSON
 * schema for the answer and the turn's text; the server keeps the history (session id). `read`
 * validates the answer; when it fails, Claude is told why once and asked again.
 */
export class ClaudeChat {
  private session: string | null = null;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  reset(): void {
    this.session = null;
  }

  get sessionId(): string | null {
    return this.session;
  }

  set sessionId(id: string | null) {
    this.session = id;
  }

  get hasHistory(): boolean {
    return this.session !== null;
  }

  async ask<T>(input: {
    system: string;
    schema: object;
    text: string;
    model: string;
    backend: AiBackend;
    signal?: AbortSignal;
    read(raw: unknown): { value: T } | { error: string };
  }): Promise<T> {
    let text = input.text;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await postTurn(this.fetchImpl, {
        backend: input.backend,
        model: input.model,
        session: this.session,
        system: input.system,
        schema: input.schema,
        text,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      this.session = reply.session;
      const checked = input.read(reply.beat);
      if ('value' in checked) return checked.value;
      text = `That answer can't be used: ${checked.error}. Send the whole answer again, fixed, in the required format.`;
    }
    throw new AiError("Claude's answer couldn't be used. Try rephrasing.", 'bad-output');
  }
}

async function postTurn(
  fetchImpl: typeof fetch,
  body: {
    backend: AiBackend;
    model: string;
    session: string | null;
    system: string;
    schema: object;
    text: string;
    signal?: AbortSignal;
  },
): Promise<{ session: string; beat: unknown }> {
  const { signal, ...payload } = body;
  let res: Response;
  try {
    res = await fetchImpl('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agstudio': '1' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new AiError("Couldn't reach the AGstudio server. Is `npm run dev` running?", 'network');
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as { session: string; beat: unknown };
}

export class ClaudeBeatChat {
  /** The server-side conversation (null until the first answer). */
  private session: string | null = null;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  /** Starts a new conversation (the next request makes a new beat). */
  reset(): void {
    this.session = null;
  }

  /** The server-side conversation id, to carry it across a page reload. */
  get sessionId(): string | null {
    return this.session;
  }

  set sessionId(id: string | null) {
    this.session = id;
  }

  get hasHistory(): boolean {
    return this.session !== null;
  }

  async request(input: {
    prompt: string;
    project: string;
    performance?: PerformanceContext | null;
    model: string;
    backend: AiBackend;
    signal?: AbortSignal;
  }): Promise<{ spec: BeatSpec; warnings: string[] }> {
    let text = userText(input.prompt, input.project, input.performance);
    // One retry when the beat doesn't validate: Claude sees the problem and fixes it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.call(input.backend, input.model, text, input.signal);
      this.session = reply.session;
      const checked = validateBeatSpec(reply.beat);
      if ('spec' in checked) return checked;
      text = `That beat can't be used: ${checked.error} Send the whole beat again, fixed.`;
    }
    throw new AiError("Claude's beat couldn't be used. Try rephrasing.", 'bad-output');
  }

  private call(
    backend: AiBackend,
    model: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ session: string; beat: unknown }> {
    return postTurn(this.fetchImpl, {
      backend,
      model,
      session: this.session,
      system: SYSTEM_PROMPT,
      schema: BEAT_JSON_SCHEMA,
      text,
      ...(signal ? { signal } : {}),
    });
  }
}

const UNREACHABLE: AiBackendStatus = { ok: false, reason: "The AGstudio server can't be reached." };

/** Which ways to reach Claude work right now. Never throws. */
export async function fetchAiStatus(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<AiStatus> {
  try {
    const res = await fetchImpl('/api/ai/status');
    if (!res.ok) return { subscription: UNREACHABLE, api: UNREACHABLE };
    const body = (await res.json()) as Partial<AiStatus>;
    const pick = (v: unknown): AiBackendStatus =>
      typeof v === 'object' && v !== null && typeof (v as AiBackendStatus).ok === 'boolean'
        ? (v as AiBackendStatus)
        : UNREACHABLE;
    return { subscription: pick(body.subscription), api: pick(body.api) };
  } catch {
    return { subscription: UNREACHABLE, api: UNREACHABLE };
  }
}
