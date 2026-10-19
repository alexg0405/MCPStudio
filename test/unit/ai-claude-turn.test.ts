/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerOf, chooseTurn, cliArgs, readResult, streamArgs, streamInput } from '../../tools/ai/claude-turn.ts';
import { installHint, subscriptionBackend } from '../../tools/ai/subscription-backend.ts';
import { currentHost, type Host } from '../../tools/platform/host.ts';
import type { BeatRequest } from '../../tools/ai/types.ts';
import { writeFakeCli } from '../helpers/fake-cli.ts';

/**
 * How a Claude Code turn reaches the CLI: the system prompt and the schema as arguments when the command line is
 * short enough for the system, otherwise inside the CLI's stream-json input. Windows stops a command line at 32 767
 * characters, and the real prompt and schema are far longer than that.
 */

const REAL_SIZE_REQUEST: BeatRequest = {
  backend: 'subscription',
  model: 'claude-opus-5-5',
  session: null,
  // The server accepts up to 60 000 characters of system prompt; the beat schema is about 76 KB.
  system: `${'You are the beat assistant. '.repeat(2100)}`.slice(0, 59_000),
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { notes: { type: 'string', description: 'x'.repeat(76_000) } },
  },
  text: '<request>dark trap</request>',
};

const SMALL_REQUEST: BeatRequest = { ...REAL_SIZE_REQUEST, system: 'Short.', schema: { type: 'object' } };

const windows: Host = {
  platform: 'win32',
  env: { PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  homeDir: 'C:\\Users\\ana',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
};
const mac: Host = { platform: 'darwin', env: {}, homeDir: '/Users/ana', nodePath: '/usr/local/bin/node' };

describe('choosing how to send a turn', () => {
  it('Windows: the real-size prompt and schema go through stdin, with a short command line', () => {
    const turn = chooseTurn(REAL_SIZE_REQUEST, 'C:\\Users\\ana\\.local\\bin\\claude.exe', windows);
    expect(turn.transport).toBe('stdin');
    expect(turn.args.join(' ').length).toBeLessThan(500);
    expect(turn.args).not.toContain('--system-prompt');
    expect(turn.args).not.toContain('--json-schema');
    expect(turn.args).toEqual(
      expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']),
    );
  });

  it('Windows: even a short turn is sent as arguments only when it fits in cmd.exe\u2019s limit too', () => {
    const exe = chooseTurn(SMALL_REQUEST, 'C:\\Users\\ana\\.local\\bin\\claude.exe', windows);
    expect(exe.transport).toBe('argv');
    const shimThatNeedsCmd = chooseTurn(
      { ...SMALL_REQUEST, system: 'x'.repeat(9_000) },
      'C:\\npm\\claude.cmd',
      windows,
      () => null,
    );
    expect(shimThatNeedsCmd.transport).toBe('stdin');
  });

  it('macOS and Linux keep the arguments for a prompt of the real size (they fit)', () => {
    const turn = chooseTurn(REAL_SIZE_REQUEST, '/Users/ana/.local/bin/claude', mac);
    expect(turn.transport).toBe('argv');
    expect(turn.args).toEqual(cliArgs(REAL_SIZE_REQUEST));
    expect(turn.input).toBe(REAL_SIZE_REQUEST.text);
  });

  it('macOS and Linux switch to stdin for a single argument past the Linux limit', () => {
    const huge = { ...REAL_SIZE_REQUEST, system: 'y'.repeat(130_000) };
    expect(chooseTurn(huge, '/usr/bin/claude', mac).transport).toBe('stdin');
  });
});

describe('the stdin transport', () => {
  it('carries the system prompt and the schema in the initialize message, then the request as one user message', () => {
    const lines = streamInput(REAL_SIZE_REQUEST).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const init = JSON.parse(lines[0] as string) as {
      type: string;
      request: { subtype: string; systemPrompt: string[]; jsonSchema: unknown };
    };
    expect(init.type).toBe('control_request');
    expect(init.request.subtype).toBe('initialize');
    expect(init.request.systemPrompt).toEqual([REAL_SIZE_REQUEST.system]);
    expect(init.request.jsonSchema).toEqual(REAL_SIZE_REQUEST.schema);
    const user = JSON.parse(lines[1] as string) as { type: string; message: { role: string; content: string } };
    expect(user.type).toBe('user');
    expect(user.message.role).toBe('user');
    expect(user.message.content).toContain('<request>dark trap</request>');
  });

  it('keeps the same isolation flags and continues a session', () => {
    const args = streamArgs({ ...SMALL_REQUEST, session: 'abc' });
    expect(args).toContain('--safe-mode');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--resume') + 1]).toBe('abc');
    expect(args).not.toContain('--bare');
  });

  it('reads the result line out of the stream, and the answer from it', () => {
    const stdout = [
      '{"type":"control_response","response":{"subtype":"success"}}',
      '{"type":"assistant","message":{}}',
      'a warning that is not JSON',
      '{"type":"result","subtype":"success","is_error":false,"session_id":"s1","structured_output":{"title":"T"}}',
      '',
    ].join('\n');
    const result = readResult(stdout, 'stdin');
    expect(result?.session_id).toBe('s1');
    expect(answerOf(result!, 'stdin')).toEqual({ title: 'T' });
    expect(readResult('no result here\n', 'stdin')).toBeNull();
    expect(readResult('{"type":"result","structured_output":1}', 'argv')?.structured_output).toBe(1);
  });

  it('falls back to a JSON answer in the text only in the stdin transport', () => {
    const result = { type: 'result', result: '```json\n{"title":"T"}\n```' };
    expect(answerOf(result, 'stdin')).toEqual({ title: 'T' });
    expect(answerOf(result, 'argv')).toBeUndefined();
    expect(answerOf({ type: 'result', result: 'sorry' }, 'stdin')).toBeUndefined();
    expect(answerOf({ type: 'result', result: '[1]' }, 'stdin')).toBeUndefined();
  });
});

/** A stand-in `claude` that understands both transports and reports what it received. */
const FAKE = `
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ authMethod: 'claude.ai' })); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const streamed = args.includes('--input-format');
  const lines = streamed ? input.trim().split('\\n').map((l) => JSON.parse(l)) : [];
  const init = lines.find((m) => m.type === 'control_request')?.request;
  const user = lines.find((m) => m.type === 'user')?.message.content;
  const report = {
    streamed,
    argLength: args.join(' ').length,
    systemLength: streamed ? init.systemPrompt.join('').length : args[args.indexOf('--system-prompt') + 1].length,
    schemaBytes: streamed ? JSON.stringify(init.jsonSchema).length : args[args.indexOf('--json-schema') + 1].length,
    user: streamed ? user : input,
    hasResume: args.includes('--resume'),
  };
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', structured_output: report };
  if (streamed) {
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'agstudio-init' } }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [] } }));
  }
  console.log(JSON.stringify(result));
});
`;

describe('a turn through a stand-in claude', () => {
  let folder = '';
  let bin = '';
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'ag-claude-turn-'));
    bin = await writeFakeCli(folder, 'claude', FAKE);
  });
  afterAll(() => rm(folder, { recursive: true, force: true }));

  type Report = { streamed: boolean; argLength: number; systemLength: number; schemaBytes: number; user: string };
  const ask = async (host: Host, req: BeatRequest) =>
    (await subscriptionBackend(() => bin, host).beat(req, new AbortController().signal)).beat as Report;

  it('delivers the full prompt and schema over stdin when the host is Windows', async () => {
    // The stand-in is not a .exe, so it runs directly here; what the "Windows" host changes is the transport.
    const host: Host = { ...currentHost(), platform: 'win32' };
    const report = await ask(host, REAL_SIZE_REQUEST);
    expect(report.streamed).toBe(true);
    expect(report.argLength).toBeLessThan(500);
    expect(report.systemLength).toBe(REAL_SIZE_REQUEST.system.length);
    expect(report.schemaBytes).toBe(JSON.stringify(REAL_SIZE_REQUEST.schema).length);
    expect(report.user).toContain('<request>dark trap</request>');
  });

  it('keeps the arguments on this machine when the prompt fits', async () => {
    if (process.platform === 'win32') return;
    const report = await ask(currentHost(), REAL_SIZE_REQUEST);
    expect(report.streamed).toBe(false);
    expect(report.systemLength).toBe(REAL_SIZE_REQUEST.system.length);
    expect(report.user).toBe('<request>dark trap</request>');
  });
});

describe('what to tell someone who has not installed Claude Code', () => {
  it('names the installer for the system and the override setting', () => {
    expect(installHint('win32')).toContain('irm https://claude.ai/install.ps1 | iex');
    expect(installHint('win32')).toContain('AGSTUDIO_CLAUDE_BIN');
    expect(installHint('darwin')).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  });
});
