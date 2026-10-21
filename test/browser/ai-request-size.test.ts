/**
 * A new chat's first turn carries the plugin and command catalogs, which grow with every feature. The dev server refuses
 * a request over its limits (tools/ai/types.ts), and that once broke every new chat ("Missing prompt."). This sends a
 * first turn from a fresh session with every feature registered and checks it fits, with room to spare.
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { BeatAssistant } from '@app/assistant/assistant';
import { registerFeatures } from '@ui/features';
import { MAX_SYSTEM_CHARS, MAX_TEXT_CHARS } from '../../tools/ai/types.ts';

/** How much of each limit a fresh first turn may use, so a few new features don't break chats again. */
const HEADROOM = 0.75;

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
    expect(sent.text).toContain('<plugins>');
    expect(sent.system.length).toBeLessThan(MAX_SYSTEM_CHARS * HEADROOM);
    expect(sent.text.length).toBeLessThan(MAX_TEXT_CHARS * HEADROOM);
  });
});
