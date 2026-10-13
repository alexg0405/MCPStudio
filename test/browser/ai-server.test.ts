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

  it('reports both backends', async () => {
    const res = await fetch('/api/ai/status');
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, { ok: boolean; reason?: string }>;
    expect(typeof body.subscription?.ok).toBe('boolean');
    expect(typeof body.api?.ok).toBe('boolean');
    if (!body.api!.ok) expect(body.api!.reason).toMatch(/ANTHROPIC_API_KEY/);
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
