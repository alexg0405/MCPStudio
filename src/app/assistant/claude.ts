import type { PerformanceRole } from '@core/beat/local';
import { BEAT_SPEC_SCHEMA, validateBeatSpec, type BeatSpec } from '@core/beat/spec';

/**
 * The beat assistant's conversation with Claude (through the dev server's /api/ai proxy, which adds
 * the API key). Claude answers by calling the `write_beat` tool; every answer is validated before
 * it touches the project, and follow-ups continue the same conversation so "make the hats busier"
 * changes the last beat instead of starting over.
 */

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest)' },
] as const;
export const DEFAULT_MODEL = AI_MODELS[0].id;

export type AiErrorKind = 'not-configured' | 'auth' | 'rate-limit' | 'overloaded' | 'network' | 'bad-output' | 'other';

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

export const SYSTEM_PROMPT = `You are the beat assistant inside AGstudio, an FL Studio-style DAW. A musician describes the beat they want and may perform part of it with their voice (beatboxing drums, or humming a bass line or melody). You answer only by calling write_beat with a complete pattern, which goes straight into their project.

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
- 3–8 tracks; bars 1–4 (2 is a good default for trap and drill).

When the musician performed something, you get it as events on the grid, with the instrument they meant:
- Follow its rhythm closely and keep their steps; only clean up obvious timing slop.
- For hummed or sung notes, keep the melodic contour (the intervals and where it slides) but move it into the right register and key for that instrument.
- Build the rest of the beat around the performance so they fit together.

When they ask for a change ("busier hats", "make the 808 slide more", "add a clap"), change only that and keep everything else from your previous beat exactly the same.

The message field is one or two friendly sentences for the musician about what you made. No lists, no step numbers.`;

const TOOL = {
  name: 'write_beat',
  description: 'Writes the beat into the musician’s project as a pattern (replacing your previous version, if any).',
  input_schema: BEAT_SPEC_SCHEMA,
};

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string | Record<string, unknown>[];
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
  let message = `Claude answered with HTTP ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    type = body.error?.type ?? '';
    if (body.error?.message) message = body.error.message;
  } catch {
    /* not JSON */
  }
  if (type === 'not_configured') return new AiError(message, 'not-configured');
  if (res.status === 401 || type === 'authentication_error')
    return new AiError('Claude rejected the API key in .env.local.', 'auth');
  if (res.status === 429) return new AiError('Claude is rate-limiting requests; try again in a moment.', 'rate-limit');
  if (res.status === 529 || type === 'overloaded_error')
    return new AiError('Claude is overloaded right now; try again shortly.', 'overloaded');
  return new AiError(message, 'other');
}

export class ClaudeBeatChat {
  private messages: Message[] = [];
  /** The tool call of the last beat: the next user turn must answer it. */
  private pending: string | null = null;

  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  /** Starts a new conversation (the next request makes a new beat). */
  reset(): void {
    this.messages = [];
    this.pending = null;
  }

  get hasHistory(): boolean {
    return this.messages.length > 0;
  }

  async request(input: {
    prompt: string;
    project: string;
    performance?: PerformanceContext | null;
    model: string;
    signal?: AbortSignal;
  }): Promise<{ spec: BeatSpec; warnings: string[] }> {
    const text = userText(input.prompt, input.project, input.performance);
    const turn: Message = {
      role: 'user',
      content: this.pending
        ? [
            { type: 'tool_result', tool_use_id: this.pending, content: 'Applied to the project.' },
            { type: 'text', text },
          ]
        : text,
    };
    const messages = [...this.messages, turn];
    // One retry when the beat doesn't validate: Claude sees the problem and fixes it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.call(messages, input.model, input.signal);
      const use = reply.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
      if (!use?.id) throw new AiError('Claude answered without writing a beat.', 'bad-output');
      if (reply.stop_reason === 'max_tokens')
        throw new AiError('The beat came back cut off. Ask for fewer bars or tracks.', 'bad-output');
      const checked = validateBeatSpec(use.input);
      messages.push({ role: 'assistant', content: reply.content as unknown as Record<string, unknown>[] });
      if ('spec' in checked) {
        this.messages = messages;
        this.pending = use.id;
        return checked;
      }
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `That beat can't be used: ${checked.error} Call write_beat again with a fixed beat.`,
          },
        ],
      });
    }
    throw new AiError("Claude's beat couldn't be used. Try rephrasing.", 'bad-output');
  }

  private async call(
    messages: Message[],
    model: string,
    signal?: AbortSignal,
  ): Promise<{ content: ContentBlock[]; stop_reason?: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl('/api/ai/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agstudio': '1' },
        body: JSON.stringify({
          model,
          max_tokens: 12000,
          system: SYSTEM_PROMPT,
          tools: [TOOL],
          tool_choice: { type: 'tool', name: TOOL.name },
          messages,
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new AiError("Couldn't reach the AGstudio server. Is `npm run dev` running?", 'network');
    }
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as { content: ContentBlock[]; stop_reason?: string };
  }
}

/** Whether the dev server has a Claude key. Never throws (false when the server can't be reached). */
export async function aiConfigured(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/ai/status');
    if (!res.ok) return false;
    return ((await res.json()) as { configured?: boolean }).configured === true;
  } catch {
    return false;
  }
}
