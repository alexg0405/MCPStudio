/**
 * A new chat's first turn must fit the AI server's limits (tools/ai/types.ts), which refuse a request over them. That once
 * broke every new chat ("Missing prompt."), when the plugin and command catalogs (about 108 000 characters) travelled in the
 * first turn's text. They are now a compact index in the system prompt and the details of what the request needs in the turn.
 * This sends a first turn from a fresh session with every feature registered and checks it fits, with room to spare.
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { BeatAssistant } from '@app/assistant/assistant';
import { registerFeatures } from '@ui/features';
import { MAX_SYSTEM_CHARS, MAX_TEXT_CHARS } from '../../tools/ai/types.ts';

/**
 * How much of each limit a fresh first turn may use, so a few new features don't break chats again. The system prompt is
 * the rules plus the index (about 77 000 of 120 000 characters); the text is the request, the project and the details
 * (about 5 000 of 400 000, or 45 000 with a very big project).
 */
const SYSTEM_HEADROOM = 0.72;
const TEXT_HEADROOM = 0.2;

describe('AI request size', () => {
  it('a new chat’s first turn fits the AI server’s limits with room to grow', async () => {
    const s = createTestServices();
    registerFeatures(s);
    let body: { system: string; text: string } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/status')) {
        return new Response(JSON.stringify({ subscription: { ok: true }, api: { ok: false }, codex: { ok: false } }), {
          status: 200,
        });
      }
      body = JSON.parse(String(init?.body)) as { system: string; text: string };
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'stub' } }), {
        status: 529,
      });
    }) as typeof fetch;
    const assistant = new BeatAssistant(s, { fetch: fetchImpl });
    await assistant.send('make a dark beat');
    expect(body, 'the turn reached the server').not.toBeNull();
    const sent = body as unknown as { system: string; text: string };
    // The catalog is an index in the system prompt, and the request's details in the text: not the whole catalog.
    expect(sent.system).toContain('Catalog index v');
    expect(sent.text).toContain('<details>');
    expect(sent.text).not.toContain('<plugins>');
    expect(sent.system.length).toBeLessThan(MAX_SYSTEM_CHARS * SYSTEM_HEADROOM);
    expect(sent.text.length).toBeLessThan(MAX_TEXT_CHARS * TEXT_HEADROOM);
  });
});
