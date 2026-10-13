/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliArgs, subscriptionBackend } from '../../tools/ai/subscription-backend.ts';
import type { BeatRequest } from '../../tools/ai/types.ts';

/**
 * The subscription backend against a stand-in `claude` (a small Node script): the flags it passes,
 * the request on stdin, the scrubbed environment, the auth check and error mapping.
 */
const FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
if (args[0] === 'auth') {
  if (mode === 'signed-out') { console.log(JSON.stringify({ authMethod: 'none' })); process.exit(1); }
  console.log(JSON.stringify({ authMethod: mode === 'api-key' ? 'api_key' : 'claude.ai' }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (mode === 'limit') {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Claude usage limit reached'] }));
    process.exit(1);
  }
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: resume || 'sess-new',
    structured_output: { title: 'Fake', args, input, apiKey: process.env.ANTHROPIC_API_KEY ?? null },
  }));
});
`;

const req = (over: Partial<BeatRequest> = {}): BeatRequest => ({
  backend: 'subscription',
  model: 'claude-opus-5-5',
  session: null,
  system: 'You are the beat assistant.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  text: '<request>dark trap</request>',
  ...over,
});

describe('Claude subscription backend', () => {
  let dir = '';
  let bin = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ag-fake-claude-'));
    bin = join(dir, 'claude');
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const backend = () => subscriptionBackend(() => bin);
  const withMode = async <T>(mode: string, fn: () => Promise<T>) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    try {
      return await fn();
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  };

  it('builds an isolated, tool-less, structured-output turn', () => {
    const args = cliArgs(req({ session: 'abc' }));
    expect(args[0]).toBe('-p');
    for (const flag of ['--safe-mode', '--output-format', '--json-schema', '--system-prompt', '--model'])
      expect(args).toContain(flag);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--resume') + 1]).toBe('abc');
    expect(args).not.toContain('--bare'); // bare mode can't use a subscription login
  });

  it('is available when Claude Code is signed in with a Claude account', async () => {
    expect(await backend().status()).toEqual({ ok: true });
    expect(await withMode('signed-out', () => backend().status())).toMatchObject({
      ok: false,
      reason: /claude auth login/,
    });
    expect(await withMode('api-key', () => backend().status())).toMatchObject({ ok: false, reason: /API key/ });
    const missing = await subscriptionBackend(() => join(dir, 'nope')).status();
    // (A real `claude` elsewhere on this machine would make it available; otherwise it says how to install.)
    if (!missing.ok) expect(missing.reason).toMatch(/install/i);
  });

  it('sends the request on stdin, without API credentials, and continues the session', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak';
    try {
      const b = backend();
      const first = await b.beat(req(), new AbortController().signal);
      expect(first.session).toBe('sess-new');
      const out = first.beat as { args: string[]; input: string; apiKey: string | null };
      expect(out.input).toBe('<request>dark trap</request>');
      expect(out.apiKey).toBeNull();
      expect(out.args).toContain('claude-opus-5-5');
      const second = await b.beat(req({ session: first.session }), new AbortController().signal);
      expect(second.session).toBe('sess-new');
      expect((second.beat as { args: string[] }).args).toContain('--resume');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('turns a plan limit into a rate-limit error', async () => {
    await expect(withMode('limit', () => backend().beat(req(), new AbortController().signal))).rejects.toMatchObject({
      type: 'rate_limit_error',
      status: 429,
    });
  });
});
