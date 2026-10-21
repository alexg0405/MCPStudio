import { describe, expect, it } from 'vitest';

/** The dev server's /api/ai endpoints (tools/ai/server.ts), as the page sees them. */
describe('AI server endpoints', () => {
  const post = (body: unknown, headers: Record<string, string> = { 'x-agstudio': '1' }) =>
    fetch('/api/ai/beat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const valid = {
    backend: 'api',
    model: 'claude-opus-5-5',
    session: null,
    system: 'system',
    schema: { type: 'object', additionalProperties: false, properties: {} },
    text: 'make a beat',
  };

  it('reports all three backends', async () => {
    const res = await fetch('/api/ai/status');
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, { ok: boolean; reason?: string }>;
    // The three backends, and what the server offers a turn besides: read tools through its MCP endpoint (a dev server has one).
    expect(Object.keys(body).sort()).toEqual(['api', 'codex', 'lookups', 'subscription']);
    expect(body.lookups).toEqual({ mcp: true });
    expect(typeof body.subscription?.ok).toBe('boolean');
    expect(typeof body.api?.ok).toBe('boolean');
    expect(typeof body.codex?.ok).toBe('boolean');
    if (!body.api!.ok) expect(body.api!.reason).toMatch(/ANTHROPIC_API_KEY/);
    // Not set up: it says what to do (install or sign in); set up: no reason.
    if (!body.codex!.ok) expect(body.codex!.reason).toMatch(/codex login|Install the ChatGPT app|ChatGPT/i);
    else expect(body.codex!.reason).toBeUndefined();
  });

  // (These requests have an empty prompt on purpose: they get as far as the checks of the backend and the model and
  // stop at "Missing prompt", so a machine with Codex signed in never makes a real model call from a test.)
  it('accepts the codex backend with Codex model ids, or none for Codex’s default', async () => {
    for (const model of ['', 'gpt-5.5', 'gpt-5.5-codex', 'o4-mini']) {
      const res = await post({ ...valid, backend: 'codex', model, text: '' });
      expect(res.status, model).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Missing prompt.');
    }
  });

  it('checks the model against its backend', async () => {
    for (const bad of [
      { backend: 'codex', model: 'Not A Model!' },
      { backend: 'codex', model: '-gpt' },
      { backend: 'codex', model: 'x'.repeat(65) },
      { backend: 'subscription', model: '' },
      { backend: 'subscription', model: 'gpt-5.5' },
      { backend: 'api', model: 'gpt-5.5' },
    ]) {
      const res = await post({ ...valid, ...bad, text: '' });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Unknown model.');
    }
  });

  it('only serves AGstudio itself', async () => {
    const res = await post(valid, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('permission_error');
  });

  it('rejects malformed requests', async () => {
    for (const bad of [
      { ...valid, backend: 'gpt' },
      { ...valid, model: 'not a model' },
      { ...valid, text: '' },
      { ...valid, schema: 'nope' },
    ]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
    }
  });

  it('explains how to set up a backend that is missing', async () => {
    const status = (await (await fetch('/api/ai/status')).json()) as Record<string, { ok: boolean }>;
    if (status.api!.ok) return; // a key is configured on this machine: nothing to check here
    const res = await post(valid);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('not_configured');
    expect(body.error.message).toMatch(/\.env\.local/);
  });
});
