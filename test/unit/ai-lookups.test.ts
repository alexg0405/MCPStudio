/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOKUP_TOOL_NAMES } from '@app/mcp/defs';
import { codexBackend, cliArgs as codexArgs, type TurnFiles } from '../../tools/ai/codex-backend.ts';
import { chooseTurn, cliArgs as claudeArgs, streamArgs, type CliLookup } from '../../tools/ai/claude-turn.ts';
import {
  claudeAllowedTools,
  claudeMcpConfig,
  codexMcpOverrides,
  looksLikeLookupFailure,
} from '../../tools/ai/lookup.ts';
import { parseRequest } from '../../tools/ai/server.ts';
import { subscriptionBackend } from '../../tools/ai/subscription-backend.ts';
import type { BeatRequest, LookupAccess } from '../../tools/ai/types.ts';
import type { Host } from '../../tools/platform/host.ts';
import { writeFakeCli } from '../helpers/fake-cli.ts';

/**
 * In-turn look-ups, backend by backend, against stand-in command line tools (no real AI is ever called): what the Claude Code
 * CLI and the Codex CLI are started with, that only the read tools can be reached and nothing holds the access token, and that a
 * look-up setup that does not work makes the turn go on without read tools instead of failing.
 */
const SECRET = 'agmcp_THIS_MUST_NEVER_LEAVE_ITS_FILE_0123456789abcdef';

let dir = '';
let tokenFile = '';
const access = (): LookupAccess => ({
  url: 'http://localhost:5401/mcp?scope=lookup',
  tokenFile,
  command: process.execPath,
  args: ['/repo/bin/agstudio-mcp.mjs'],
  tools: LOOKUP_TOOL_NAMES,
});

const req = (over: Partial<BeatRequest> = {}): BeatRequest => ({
  backend: 'subscription',
  model: 'claude-opus-5-5',
  session: null,
  system: 'You are Studio.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  text: '<request>add reverb</request>',
  ...over,
});

/** Tools that change the project, play it or render it: none of them may be reachable from a turn. */
const WRITE_TOOLS = [
  'apply_actions',
  'run_command',
  'play',
  'stop',
  'seek',
  'set_loop',
  'undo',
  'redo',
  'export_audio',
  'export_video',
  'render_preview',
  'analyze_mix',
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ag-lookups-'));
  tokenFile = join(dir, 'mcp-token');
  await writeFile(tokenFile, `${SECRET}\n`);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('what the helper is told', () => {
  it('names the read-only endpoint and the token file, never the token', () => {
    const config = JSON.parse(claudeMcpConfig(access())) as {
      mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(['agstudio']);
    const server = config.mcpServers.agstudio!;
    expect(server).toMatchObject({ type: 'stdio', command: process.execPath, args: ['/repo/bin/agstudio-mcp.mjs'] });
    expect(server.env).toEqual({ AGSTUDIO_MCP_URL: 'http://localhost:5401/mcp?scope=lookup', AGSTUDIO_MCP_TOKEN_FILE: tokenFile });
    expect(claudeMcpConfig(access())).not.toContain(SECRET);
  });

  it('allows the read tools one by one, with their full names, and no write tool', () => {
    const allowed = claudeAllowedTools(access());
    expect(allowed).toEqual(LOOKUP_TOOL_NAMES.map((name) => `mcp__agstudio__${name}`));
    expect(allowed).toContain('mcp__agstudio__get_plugin_details');
    expect(allowed).toContain('mcp__agstudio__search_catalog');
    for (const write of WRITE_TOOLS) expect(allowed, write).not.toContain(`mcp__agstudio__${write}`);
    // never the whole server (`mcp__agstudio`, `mcp__agstudio__*`)
    expect(allowed.every((name) => /^mcp__agstudio__[a-z_]+$/.test(name))).toBe(true);
  });

  it('knows a failure that is about the look-up setup', () => {
    expect(looksLikeLookupFailure('Invalid MCP configuration: bad json')).toBe(true);
    expect(looksLikeLookupFailure('invalid value for mcp_servers.agstudio.enabled_tools')).toBe(true);
    expect(looksLikeLookupFailure('Your plan’s usage limit is reached')).toBe(false);
  });
});

describe('Claude Code command line', () => {
  const lookup: CliLookup = { mcpConfigPath: '/tmp/mcp.json', allowedTools: ['mcp__agstudio__get_plugins', 'mcp__agstudio__get_mixer'] };

  it('has no MCP, no allowed tools and three turns without a look-up', () => {
    const args = claudeArgs(req());
    for (const flag of ['--mcp-config', '--strict-mcp-config', '--allowedTools']) expect(args).not.toContain(flag);
    expect(args[args.indexOf('--max-turns') + 1]).toBe('3');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('with a look-up: the config, only that config, the read tools by name, six turns, still no built-in tools', () => {
    const args = claudeArgs(req(), lookup);
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__agstudio__get_plugins,mcp__agstudio__get_mixer');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('6');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--safe-mode');
  });

  it('keeps each list option away from the prompt: another option always follows its values', () => {
    for (const args of [claudeArgs(req(), lookup), streamArgs(req(), lookup)]) {
      expect(args[args.indexOf('--mcp-config') + 2]).toBe('--strict-mcp-config');
      expect(args[args.indexOf('--allowedTools') + 2]).toMatch(/^--/);
    }
  });

  it('keeps the flags on the stdin transport (Windows), whose command line stays short', () => {
    const windows: Host = {
      platform: 'win32',
      env: { PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      homeDir: 'C:\\Users\\ana',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    };
    const turn = chooseTurn(req({ system: 'x'.repeat(80_000) }), 'C:\\Users\\ana\\.local\\bin\\claude.exe', windows, undefined, lookup);
    expect(turn.transport).toBe('stdin');
    expect(turn.args).toEqual(expect.arrayContaining(['--mcp-config', '--strict-mcp-config', '--allowedTools']));
    expect(turn.args.join(' ').length).toBeLessThan(1_500);
  });
});

/** A stand-in `claude`: it answers with the command line it got, the config file's content at that moment, and its environment. */
const FAKE_CLAUDE = `const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ authMethod: 'claude.ai' })); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const at = args.indexOf('--mcp-config');
  const configPath = at >= 0 ? args[at + 1] : null;
  if (configPath && process.env.FAKE_CLAUDE_MODE === 'mcp-broken') {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Invalid MCP configuration: could not start the "agstudio" server'] }));
    process.exit(1);
  }
  const config = configPath ? fs.readFileSync(configPath, 'utf8') : null;
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'sess-new',
    structured_output: { args, config, configPath, env: process.env },
  }));
});
`;

type ClaudeAnswer = { args: string[]; config: string | null; configPath: string | null; env: Record<string, string> };

describe('the subscription backend with look-ups', () => {
  let bin = '';
  beforeAll(async () => {
    bin = await writeFakeCli(dir, 'claude', FAKE_CLAUDE);
  });
  const backend = () => subscriptionBackend(() => bin);
  const ask = async (request: BeatRequest, lookup?: LookupAccess) =>
    (await backend().beat(request, new AbortController().signal, lookup)).beat as ClaudeAnswer;
  const withMode = async <T>(mode: string, fn: () => Promise<T>) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    try {
      return await fn();
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  };
  const tempConfigs = async () => (await readdir(join(tmpdir(), 'agstudio-claude')).catch(() => [] as string[])).filter((n) => n.startsWith('mcp-'));

  it('runs a turn with the read-only server, and the config is there for the turn and gone after it', async () => {
    const answer = await ask(req({ readTools: true }), access());
    expect(answer.args).toEqual(expect.arrayContaining(['--mcp-config', '--strict-mcp-config', '--allowedTools']));
    expect(answer.args[answer.args.indexOf('--max-turns') + 1]).toBe('6');
    const config = JSON.parse(answer.config!) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(config.mcpServers.agstudio!.env.AGSTUDIO_MCP_URL).toContain('?scope=lookup');
    expect(await tempConfigs()).toEqual([]);
  });

  it('allows the read tools and no write tool', async () => {
    const answer = await ask(req({ readTools: true }), access());
    const allowed = answer.args[answer.args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual(claudeAllowedTools(access()));
    for (const write of WRITE_TOOLS) expect(allowed.join(' '), write).not.toContain(write);
    expect(answer.args.join(' ')).not.toMatch(/mcp__agstudio(__\*)?(\s|,|$)/);
  });

  it('never puts the token in the command line, the config or the environment', async () => {
    const answer = await ask(req({ readTools: true }), access());
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('has no look-up unless the request asks for read tools and the server can offer them', async () => {
    for (const [request, lookup] of [
      [req(), access()],
      [req({ readTools: true }), undefined],
    ] as const) {
      const answer = await ask(request, lookup);
      expect(answer.args).not.toContain('--mcp-config');
      expect(answer.args).not.toContain('--allowedTools');
      expect(answer.args[answer.args.indexOf('--max-turns') + 1]).toBe('3');
    }
  });

  it('goes on without read tools when the CLI does not accept the look-up setup', async () => {
    const answer = await withMode('mcp-broken', () => ask(req({ readTools: true }), access()));
    expect(answer.args).not.toContain('--mcp-config');
    expect(answer.args[answer.args.indexOf('--max-turns') + 1]).toBe('3');
    expect(await tempConfigs()).toEqual([]);
  });
});

const FILES: TurnFiles = { instructions: '/t/instructions.md', schema: '/t/schema.json', out: '/t/answer.txt' };

describe('Codex command line', () => {
  it('has no MCP server without a look-up', () => {
    const args = codexArgs(req({ backend: 'codex' }), FILES, ['apps']);
    expect(args.join(' ')).not.toContain('mcp_servers');
  });

  it('with a look-up: the helper, its environment, only the read tools, approved in advance, next to the other flags', () => {
    const args = codexArgs(req({ backend: 'codex' }), FILES, ['apps'], access());
    const value = (key: string) => args.find((a) => a.startsWith(`mcp_servers.agstudio.${key}=`))!.slice(`mcp_servers.agstudio.${key}=`.length);
    expect(JSON.parse(value('command'))).toBe(process.execPath);
    expect(JSON.parse(value('args'))).toEqual(['/repo/bin/agstudio-mcp.mjs']);
    expect(value('env')).toContain('AGSTUDIO_MCP_URL="http://localhost:5401/mcp?scope=lookup"');
    expect(value('env')).toContain(`AGSTUDIO_MCP_TOKEN_FILE=${JSON.stringify(tokenFile)}`);
    expect(JSON.parse(value('enabled_tools'))).toEqual([...LOOKUP_TOOL_NAMES]);
    expect(value('default_tools_approval_mode')).toBe('"approve"');
    for (const write of WRITE_TOOLS) expect(value('enabled_tools'), write).not.toContain(`"${write}"`);
    // each setting follows a -c, and the isolation flags are still there
    for (const [i, arg] of args.entries()) if (arg.startsWith('mcp_servers.')) expect(args[i - 1]).toBe('-c');
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--disable', 'apps']));
    expect(args.join(' ')).toContain('sandbox_mode="read-only"');
    expect(args.join(' ')).not.toContain(SECRET);
  });

  it('writes its overrides as TOML the CLI reads', () => {
    const settings = codexMcpOverrides(access()).filter((a) => a !== '-c');
    expect(settings.map((s) => s.split('=')[0])).toEqual([
      'mcp_servers.agstudio.command',
      'mcp_servers.agstudio.args',
      'mcp_servers.agstudio.env',
      'mcp_servers.agstudio.enabled_tools',
      'mcp_servers.agstudio.default_tools_approval_mode',
      'mcp_servers.agstudio.startup_timeout_sec',
      'mcp_servers.agstudio.tool_timeout_sec',
    ]);
  });
});

/** A stand-in `codex`: it answers with the command line it got. */
const FAKE_CODEX = `const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'features' && args[1] === 'list') { console.log('apps  stable  true'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const emit = (e) => console.log(JSON.stringify(e));
  const out = args[args.indexOf('-o') + 1];
  emit({ type: 'thread.started', thread_id: 'thread-new' });
  if (process.env.FAKE_CODEX_MODE === 'mcp-broken' && args.some((a) => a.startsWith('mcp_servers.'))) {
    emit({ type: 'turn.failed', error: { message: 'invalid value for mcp_servers.agstudio.default_tools_approval_mode' } });
    process.exit(1);
  }
  const text = JSON.stringify({ args, env: process.env });
  emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
  fs.writeFileSync(out, text);
  process.exit(0);
});
`;

describe('the Codex backend with look-ups', () => {
  let bin = '';
  beforeAll(async () => {
    bin = await writeFakeCli(dir, 'codex', FAKE_CODEX);
  });
  const ask = async (request: BeatRequest, lookup?: LookupAccess) =>
    (await codexBackend(() => bin).beat(request, new AbortController().signal, lookup)).beat as { args: string[] };

  it('runs a turn with the read-only server and without the token anywhere', async () => {
    const answer = await ask(req({ backend: 'codex', model: '', readTools: true }), access());
    expect(answer.args.some((a) => a.startsWith('mcp_servers.agstudio.enabled_tools='))).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('has no look-up unless asked for and offered', async () => {
    for (const [request, lookup] of [
      [req({ backend: 'codex', model: '' }), access()],
      [req({ backend: 'codex', model: '', readTools: true }), undefined],
    ] as const) {
      const answer = await ask(request, lookup);
      expect(answer.args.join(' ')).not.toContain('mcp_servers');
    }
  });

  it('goes on without read tools when this Codex does not accept the look-up setup', async () => {
    process.env.FAKE_CODEX_MODE = 'mcp-broken';
    try {
      const answer = await ask(req({ backend: 'codex', model: '', readTools: true }), access());
      expect(answer.args.join(' ')).not.toContain('mcp_servers');
    } finally {
      delete process.env.FAKE_CODEX_MODE;
    }
  });
});

describe('what the server accepts from the page', () => {
  const body = (extra: Record<string, unknown>) =>
    JSON.stringify({
      backend: 'subscription',
      model: 'claude-opus-5-5',
      session: null,
      system: 'rules\n\nindex',
      schema: { type: 'object' },
      text: 'hi',
      ...extra,
    });

  it('passes on readTools and the system blocks that add up to the system prompt', () => {
    const parsed = parseRequest(body({ readTools: true, systemBlocks: ['rules', 'index'] }));
    expect(parsed.readTools).toBe(true);
    expect(parsed.systemBlocks).toEqual(['rules', 'index']);
  });

  it('drops blocks that do not add up, and a readTools that is not exactly true', () => {
    for (const extra of [{ systemBlocks: ['rules', 'other'] }, { systemBlocks: [1, 2] }, { systemBlocks: [] }, { readTools: 'yes' }]) {
      const parsed = parseRequest(body(extra));
      expect(parsed.systemBlocks, JSON.stringify(extra)).toBeUndefined();
      expect(parsed.readTools, JSON.stringify(extra)).toBeUndefined();
    }
  });
});
