/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  TOOL_FEATURES,
  cliArgs,
  codexBackend,
  enabledFeatures,
  failure,
  readEvents,
  type TurnFiles,
} from '../../tools/ai/codex-backend.ts';
import type { BeatRequest } from '../../tools/ai/types.ts';
import { writeFakeCli } from '../helpers/fake-cli.ts';

/**
 * The Codex backend against a stand-in `codex` (a small Node script): the exact command line, the request on
 * stdin, the temp files (written, then gone), the scrubbed environment, thread resume, the login check and the
 * error mapping. No real model is ever called.
 */
const FAKE = `const fs = require('fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (args[0] === 'login' && args[1] === 'status') {
  if (mode === 'signed-out') { console.log('Not logged in'); process.exit(1); }
  if (mode === 'api-key') { console.log('Logged in using an API key - sk-proj-****abcd'); process.exit(0); }
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] === 'features' && args[1] === 'list') {
  console.log('apps                                     stable             true');
  console.log('browser_use                              stable             true');
  console.log('computer_use                             stable             true');
  console.log('shell_tool                               stable             false');
  console.log('memories                                 stable             false');
  console.log('fast_mode                                stable             true');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (mode === 'hang') { setTimeout(() => process.exit(0), 60000); return; }
  const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const out = after('-o');
  const instructionsPath = (args.find((a) => a.startsWith('model_instructions_file=')) || '').slice('model_instructions_file='.length).replace(/^"|"$/g, '');
  const schemaPath = after('--output-schema');
  const resume = args[1] === 'resume' ? args[args.indexOf('--all') + 1] : null;
  const thread = resume || 'thread-new';
  const emit = (e) => console.log(JSON.stringify(e));
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  if (mode === 'limit') {
    emit({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro or try again in 3 hours." });
    emit({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 3 hours." } });
    process.exit(1);
  }
  if (mode === 'unauthorized') {
    emit({ type: 'turn.failed', error: { message: '401 Unauthorized: your access token could not be refreshed' } });
    process.exit(1);
  }
  const answer = {
    title: 'Fake', args, input, cwd: process.cwd(),
    instructions: fs.readFileSync(instructionsPath, 'utf8'),
    schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8')),
    env: { key: process.env.OPENAI_API_KEY ?? 'unset', base: process.env.OPENAI_BASE_URL ?? 'unset', codex: process.env.CODEX_API_KEY ?? 'unset' },
    empty: null,
    nested: { kept: 1, dropped: null },
    list: [{ a: 1, b: null }],
  };
  const text = mode === 'garbage' ? 'sorry, here is no JSON' : JSON.stringify(answer);
  emit({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } });
  emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  if (mode !== 'no-out-file' && mode !== 'empty') fs.writeFileSync(out, text);
  if (mode === 'empty') fs.writeFileSync(out, '');
  process.exit(0);
});
`;

const req = (over: Partial<BeatRequest> = {}): BeatRequest => ({
  backend: 'codex',
  model: '',
  session: null,
  system: 'You are the beat assistant.',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string' }, bpm: { type: 'number' } },
    required: ['title'],
  },
  text: '<request>dark trap</request>',
  ...over,
});

const FILES: TurnFiles = { instructions: '/t/instructions.md', schema: '/t/schema.json', out: '/t/answer.txt' };

type Answer = {
  title: string;
  args: string[];
  input: string;
  cwd: string;
  instructions: string;
  schema: { properties: Record<string, unknown>; required: string[] };
  env: { key: string; base: string; codex: string };
  empty?: unknown;
  nested: Record<string, unknown>;
  list: Record<string, unknown>[];
};

describe('Codex backend', () => {
  let dir = '';
  let bin = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ag-fake-codex-'));
    bin = await writeFakeCli(dir, 'codex', FAKE);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const backend = () => codexBackend(() => bin);
  const withMode = async <T>(mode: string, fn: () => Promise<T>) => {
    process.env.FAKE_CODEX_MODE = mode;
    try {
      return await fn();
    } finally {
      delete process.env.FAKE_CODEX_MODE;
    }
  };
  const ask = (b: ReturnType<typeof backend>, r = req()) => b.beat(r, new AbortController().signal);
  const turnDirs = async () =>
    (await readdir(join(tmpdir(), 'agstudio-codex')).catch(() => [] as string[])).filter((n) => n !== 'work');

  describe('command line', () => {
    it('builds a fresh, tool-less, structured-output turn', () => {
      expect(cliArgs(req(), FILES, ['apps', 'computer_use'])).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ignore-rules',
        '-c',
        'sandbox_mode="read-only"',
        '-c',
        'approval_policy="never"',
        '-c',
        'model_instructions_file="/t/instructions.md"',
        '-c',
        'project_doc_max_bytes=0',
        '-c',
        'web_search="disabled"',
        '-c',
        'model_reasoning_effort="medium"',
        '--disable',
        'apps',
        '--disable',
        'computer_use',
        '--output-schema',
        '/t/schema.json',
        '-o',
        '/t/answer.txt',
        '-',
      ]);
    });

    it('resumes a thread with the same flags (and no flag that resume lacks), model only when chosen', () => {
      const args = cliArgs(req({ session: '0198f0aa-1111-7222-8333-444455556666', model: 'gpt-5.5' }), FILES, []);
      expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(args.slice(args.indexOf('-m'))).toEqual(['-m', 'gpt-5.5', '--all', '0198f0aa-1111-7222-8333-444455556666', '-']);
      // `exec resume` takes neither --sandbox nor -C; they must not be passed.
      for (const flag of ['-s', '--sandbox', '-C', '--cd', '--ephemeral']) expect(args).not.toContain(flag);
      expect(cliArgs(req(), FILES, [])).not.toContain('-m');
    });

    it('writes a Windows file path as a valid TOML string (backslashes escaped)', () => {
      const files: TurnFiles = { instructions: 'C:\\Users\\ana\\Temp\\t\\instructions.md', schema: 'C:\\s.json', out: 'C:\\o.txt' };
      expect(cliArgs(req(), files, [])).toContain('model_instructions_file="C:\\\\Users\\\\ana\\\\Temp\\\\t\\\\instructions.md"');
    });

    it('never lets a session id look like an option', () => {
      const args = cliArgs(req({ session: '--dangerously-bypass-approvals-and-sandbox' }), FILES, []);
      expect(args[1]).toBe('--json'); // not a resume
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('turns every tool-like feature off', () => {
      for (const f of ['shell_tool', 'browser_use', 'computer_use', 'apps', 'plugins', 'multi_agent', 'image_generation', 'view_image'])
        expect(TOOL_FEATURES).toContain(f);
    });

    it('reads the feature table', () => {
      const on = enabledFeatures('apps   stable   true\nmemories  stable  false\n\nbrowser_use stable true  \nweird line');
      expect([...on].sort()).toEqual(['apps', 'browser_use']);
    });
  });

  describe('login check', () => {
    it('is available when Codex is signed in with a ChatGPT account', async () => {
      expect(await backend().status()).toEqual({ ok: true });
    });
    it('says how to sign in, and refuses an API-key login', async () => {
      expect(await withMode('signed-out', () => backend().status())).toMatchObject({ ok: false, reason: /codex login/ });
      const key = await withMode('api-key', () => backend().status());
      expect(key).toMatchObject({ ok: false, reason: /API key.*not your ChatGPT plan/ });
      expect(JSON.stringify(key)).not.toMatch(/sk-/); // the CLI's masked key is never passed on
    });
    it('says how to install when there is no Codex', async () => {
      const missing = await codexBackend(() => join(dir, 'nope')).status();
      // (A real `codex` elsewhere on this machine would make it available; otherwise it says how to install.)
      if (!missing.ok) expect(missing.reason).toMatch(/install/i);
    });
    it('removes turn folders a crashed server left behind (older than an hour), not recent ones', async () => {
      const base = join(tmpdir(), 'agstudio-codex');
      const old = join(base, 'stale-test-old');
      const recent = join(base, 'stale-test-recent');
      await mkdir(old, { recursive: true });
      await mkdir(recent, { recursive: true });
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await utimes(old, twoHoursAgo, twoHoursAgo);
      await backend().status();
      await expect(access(old)).rejects.toThrow();
      await expect(access(recent)).resolves.toBeUndefined();
      await rm(recent, { recursive: true, force: true });
    });
    it('remembers the answer for a few seconds', async () => {
      const b = backend();
      expect(await b.status()).toEqual({ ok: true });
      expect(await withMode('signed-out', () => b.status())).toEqual({ ok: true });
    });
  });

  describe('a turn', () => {
    it('sends the request on stdin, the prompt and strict schema as files that are gone afterwards, in an empty folder', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-should-not-leak';
      process.env.OPENAI_BASE_URL = 'https://example.invalid';
      process.env.CODEX_API_KEY = 'codex-test-should-not-leak';
      try {
        const reply = await ask(backend());
        const out = reply.beat as Answer;
        expect(reply.session).toBe('thread-new');
        expect(reply.model).toBe('');
        expect(out.input).toBe('<request>dark trap</request>');
        expect(out.env).toEqual({ key: 'unset', base: 'unset', codex: 'unset' });
        expect(out.instructions).toBe('You are the beat assistant.');
        // strict form: every property required, the optional one nullable
        expect(out.schema.required).toEqual(['title', 'bpm']);
        expect(out.schema.properties.bpm).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
        // the temp files lived under agstudio-codex/<turn>, the working folder is the empty agstudio-codex/work
        const instructions = out.args.find((a) => a.startsWith('model_instructions_file='))!.slice(24).replace(/"/g, '');
        expect(instructions).toContain(join(tmpdir(), 'agstudio-codex'));
        await expect(access(instructions)).rejects.toThrow();
        await expect(access(dirname(instructions))).rejects.toThrow();
        expect(out.cwd.endsWith(join('agstudio-codex', 'work'))).toBe(true);
        expect(await readdir(out.cwd)).toEqual([]);
        expect(out.args.slice(0, 1)).toEqual(['exec']);
        expect(out.args.at(-1)).toBe('-');
        // only the features this Codex lists as on, and that we know are tool-like, are disabled
        const disabled = out.args.filter((_, i) => out.args[i - 1] === '--disable');
        expect(disabled).toEqual(['apps', 'browser_use', 'computer_use']);
      } finally {
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
        delete process.env.CODEX_API_KEY;
      }
    });

    it('continues the thread and passes a chosen model', async () => {
      const b = backend();
      const first = await ask(b);
      const second = await ask(b, req({ session: first.session, model: 'gpt-5.5' }));
      expect(second.session).toBe('thread-new');
      const args = (second.beat as Answer).args;
      expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(args).toContain('thread-new');
      expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
      expect(second.model).toBe('gpt-5.5');
    });

    it('deletes every property the model sent as null (the original schemas have no null)', async () => {
      const out = (await ask(backend())).beat as Answer;
      expect('empty' in out).toBe(false);
      expect(out.nested).toEqual({ kept: 1 });
      expect(out.list).toEqual([{ a: 1 }]);
    });

    it('falls back to the last agent message when the answer file is missing or empty', async () => {
      for (const mode of ['no-out-file', 'empty']) {
        const reply = await withMode(mode, () => ask(backend()));
        expect((reply.beat as Answer).title).toBe('Fake');
      }
    });

    it('turns a plan limit into a rate-limit error', async () => {
      await expect(withMode('limit', () => ask(backend()))).rejects.toMatchObject({ type: 'rate_limit_error', status: 429 });
      expect(await turnDirs()).toEqual([]);
    });

    it('asks to sign in again when the login stopped working', async () => {
      await expect(withMode('unauthorized', () => ask(backend()))).rejects.toMatchObject({
        type: 'not_signed_in',
        status: 503,
        message: /codex login/,
      });
    });

    it('reports an answer that is not JSON', async () => {
      await expect(withMode('garbage', () => ask(backend()))).rejects.toMatchObject({ type: 'bad_output', status: 502 });
      expect(await turnDirs()).toEqual([]);
    });

    it('refuses to run when nobody is signed in', async () => {
      await expect(withMode('signed-out', () => ask(backend()))).rejects.toMatchObject({ type: 'not_configured', status: 503 });
    });

    it('stops the process when the page stops waiting, and still cleans up', async () => {
      const abort = new AbortController();
      const b = backend();
      await b.status();
      const p = withMode('hang', () => b.beat(req(), abort.signal));
      setTimeout(() => abort.abort(), 700);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(await turnDirs()).toEqual([]);
    });
  });

  describe('error mapping', () => {
    it.each([
      ["You've hit your usage limit. Try again later.", 'rate_limit_error', 429],
      ['429 Too Many Requests', 'rate_limit_error', 429],
      ['The model `gpt-9` does not exist or is not supported', 'invalid_request_error', 400],
      ['401 Unauthorized', 'not_signed_in', 503],
      ['Please log in again', 'not_signed_in', 503],
      ['Selected model is at capacity, overloaded', 'overloaded_error', 529],
      ['no session found with id abc', 'api_error', 502],
      ['something odd', 'api_error', 502],
    ])('%s', (text, type, status) => {
      expect(failure(text, 'gpt-9', '/usr/local/bin/codex')).toMatchObject({ type, status });
    });

    it('reads the JSONL events and ignores other output', () => {
      const e = readEvents(
        [
          'WARN something',
          '{"type":"thread.started","thread_id":"t1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"one"}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"two"}}',
          '{"type":"error","message":"Reconnecting 1/5"}',
          '{"type":"turn.failed","error":{"message":"boom"}}',
          '{not json',
        ].join('\n'),
      );
      expect(e).toEqual({ thread: 't1', message: 'two', errors: ['Reconnecting 1/5', 'boom'], failed: true });
    });
  });
});
